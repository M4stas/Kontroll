"""Process queued Auto24 listing extractions one job at a time."""

from __future__ import annotations

import argparse
import functools
import logging
import os
import secrets
import time
import tempfile
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from auto24_service.browser import LEASE_SAFETY_SECONDS, CaptureError, CaptureResult, capture_listing
from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
from auto24_service.captcha.solver import load_solver, parse_lookup_enabled
from auto24_service.diagnostics import NULL_OBSERVER, SpanRecorder
from auto24_service.contracts import ListingResult, Registration, RevealDiagnostics
from auto24_service.parser import ParseError, parse_listing
from auto24_service.storage_client import StorageClient
from auto24_service.store import ClaimedJob
from auto24_service.warm_profile import WarmProfile


_ERROR_MESSAGES = {
    "listing_gone": "Listing is no longer available.",
    "access_blocked": "Access to the listing was blocked.",
    "unsupported_vehicle_type": "The listing is not for a passenger car.",
    "parse_failed": "The listing could not be parsed.",
    "temporary_failure": "The listing could not be fetched temporarily.",
}
_ERROR_CODES = frozenset(_ERROR_MESSAGES)
_LOGGER = logging.getLogger(__name__)
# Called as capture(url, deadline=<time.monotonic() value>, on_html=<callback>
# [, observer=<PhaseObserver>]). on_html(html) parses and completes the job before
# the reveal and returns whether it completed. The observer is passed only while
# capture timings are enabled.
CaptureListing = Callable[..., CaptureResult]


def warm_capture(capture: CaptureListing, warm: WarmProfile) -> CaptureListing:
    """Reuse a worker profile and account for each finished capture once."""
    def record(
        error_code: str | None = None,
        diagnostics: RevealDiagnostics | None = None,
        registration: Registration | None = None,
    ) -> None:
        jobs = warm.jobs + 1
        reason = warm.record_outcome(error_code, diagnostics, registration)
        _LOGGER.info("profile_jobs=%s", jobs)
        if reason is not None:
            _LOGGER.info("profile_reset reason=%s", reason)

    def wrapped(*args, **kwargs) -> CaptureResult:
        profile = warm.path()
        try:
            result = capture(*args, **kwargs, keep_profile=profile)
        except CaptureError as exc:
            record(exc.code)
            raise
        except Exception:
            record()
            raise
        record(None, result.reveal_diagnostics, result.registration)
        return result

    return wrapped


def capture_deadline(lease_left: float) -> float:
    """The `time.monotonic()` value a capture must end by, `lease_left` seconds into a lease."""
    return time.monotonic() + lease_left - LEASE_SAFETY_SECONDS
_FORCE_FAILURE_ENVS = frozenset({"development", "test"})
ParseListing = Callable[[str, str], tuple[ListingResult, list[str]]]


def _capture_error_code(error: Exception) -> str:
    if isinstance(error, CaptureError) and error.code in _ERROR_CODES:
        return error.code
    return "temporary_failure"


def _parse_error_code(error: Exception) -> str:
    if isinstance(error, ParseError) and error.code in {
        "unsupported_vehicle_type",
        "parse_failed",
    }:
        return error.code
    return "parse_failed"


def _omitted_option(recorder: SpanRecorder | None) -> dict[str, int]:
    # Spans dropped at the flush deadline are reported with the final update.
    return {"diagnostic_omitted": recorder.omitted} if recorder is not None and recorder.omitted else {}


def _fail(client: StorageClient, claim: ClaimedJob, code: str, recorder: SpanRecorder | None = None) -> None:
    updated = client.fail(
        claim.job_id,
        claim.lease_token,
        code,
        _ERROR_MESSAGES[code],
        code == "temporary_failure",
        **_omitted_option(recorder),
    )
    action = "failure_recorded" if updated else "failure_rejected"
    _LOGGER.warning("job_id=%s action=%s code=%s", claim.job_id, action, code)


def _log_statuses(
    claim: ClaimedJob,
    updated: bool,
    registration: Registration | None,
    diagnostics: RevealDiagnostics | None,
    saved: bool | None = None,
) -> None:
    # Statuses only: revealed values never go into logs. `saved` says whether storage
    # took the identity update; None means no update was attempted.
    fallback = "pending" if updated else "none"
    note = "" if saved is None else (" registration=saved" if saved else " registration=rejected")
    _LOGGER.info(
        "job_id=%s status=%s reg_number_status=%s vin_status=%s initial_rejected=%s%s",
        claim.job_id,
        "completed" if updated else "superseded",
        registration.reg_number_status if registration else fallback,
        registration.vin_status if registration else fallback,
        ",".join(diagnostics.initial_rejected) if diagnostics else "",
        note,
    )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def run_once(
    client: StorageClient,
    capture: CaptureListing,
    parser: ParseListing,
    *, diagnostics_enabled: bool = False,
) -> bool:
    """Claim and process at most one job; return whether a job was claimed."""
    claim = client.claim()
    if claim is None:
        return False

    lease_left = (claim.lease_until - _utcnow()).total_seconds()
    deadline = capture_deadline(lease_left)
    recorder = SpanRecorder(
        lambda spans: client.record_spans(claim.job_id, claim.lease_token, spans, timeout=1.0),
        job_id=claim.job_id, attempt=claim.attempts,
        on_omitted=lambda count: client.record_spans(
            claim.job_id, claim.lease_token, [], timeout=1.0, omitted=count
        ),
    ) if diagnostics_enabled else None

    def finish_diagnostics():
        if recorder is not None:
            try:
                recorder.flush(.1)
            finally:
                recorder.close()

    # Set by on_html: the token once complete() returned, and whether it updated the job.
    completion: dict = {}

    def on_html(html: str) -> bool:
        try:
            with (recorder or NULL_OBSERVER).phase("parsing"):
                listing, warnings = parser(html, claim.source_url)
        except Exception as exc:
            finish_diagnostics()
            completion["failed"] = True
            _fail(client, claim, _parse_error_code(exc), recorder)
            return False
        # The reveal runs after completion and fills these in with the token.
        listing.registration = Registration.pending()
        finish_diagnostics()
        token = secrets.token_urlsafe(16)
        updated = client.complete(
            claim.job_id,
            claim.lease_token,
            listing.model_dump(mode="json"),
            warnings,
            reveal_token=token,
            **_omitted_option(recorder),
        )
        completion.update(token=token, updated=updated)
        return updated

    try:
        try:
            observer_option = {"observer": recorder} if recorder is not None else {}
            captured = capture(claim.source_url, deadline=deadline, on_html=on_html, **observer_option)
        except Exception as exc:
            if completion.get("failed"):
                # on_html already reported the failure; a wrapped error must not re-record it.
                return True
            if "token" in completion:
                # The lease ended at completion: post nothing, the pending fields expire.
                _log_statuses(claim, completion["updated"], None, None)
                return True
            finish_diagnostics()
            _fail(client, claim, _capture_error_code(exc), recorder)
            return True

        if "token" not in completion:
            return True
        registration = captured.registration
        saved = None
        if completion["updated"] and registration is not None:
            try:
                saved = client.set_registration(
                    claim.job_id, completion["token"], registration, captured.reveal_diagnostics
                )
            except Exception as exc:
                _LOGGER.warning(
                    "job_id=%s action=registration_not_saved error=%s", claim.job_id, type(exc).__name__
                )
        _log_statuses(claim, completion["updated"], registration, captured.reveal_diagnostics, saved)
        return True
    finally:
        if recorder is not None:
            recorder.close()


def run_forever(
    client: StorageClient,
    capture: CaptureListing,
    parser: ParseListing,
    *, diagnostics_enabled: bool = False,
) -> None:
    """Process jobs sequentially, sleeping two seconds while the queue is idle."""
    while True:
        options = {"diagnostics_enabled": True} if diagnostics_enabled else {}
        if not run_once(client, capture, parser, **options):
            time.sleep(2)


def parse_capture_engine(value: str | None) -> Literal["camoufox", "chromium"]:
    if value is None:
        return "camoufox"
    if value in ("camoufox", "chromium"):
        return value
    raise ValueError("CAPTURE_ENGINE must be camoufox or chromium")


def main(argv: Sequence[str] | None = None) -> int:
    argument_parser = argparse.ArgumentParser(description="Process Auto24 extraction jobs")
    argument_parser.add_argument(
        "--once", action="store_true", help="process one eligible job and exit"
    )
    arguments = argument_parser.parse_args(argv)
    try:
        engine = parse_capture_engine(os.environ.get("CAPTURE_ENGINE"))
    except ValueError as exc:
        argument_parser.error(str(exc))
    storage_url = os.environ.get("STORAGE_URL", "")
    internal_key = os.environ.get("INTERNAL_API_KEY", "")
    if not storage_url or not internal_key:
        argument_parser.error("STORAGE_URL and INTERNAL_API_KEY must be set")

    auto24_env = os.environ.get("AUTO24_ENV", "production")
    force_setting = os.environ.get("REVEAL_FORCE_FAILURE", "false").strip().casefold()
    if force_setting not in {"true", "false"}:
        argument_parser.error("REVEAL_FORCE_FAILURE must be true or false")
    force_failure = force_setting == "true"
    if force_failure and auto24_env not in _FORCE_FAILURE_ENVS:
        argument_parser.error(
            "REVEAL_FORCE_FAILURE=true is only allowed when AUTO24_ENV is development or test"
        )
    if engine == "chromium":
        warm_setting = os.environ.get("CHROMIUM_WARM_PROFILE", "true").strip().casefold()
        if warm_setting not in {"true", "false"}:
            argument_parser.error("CHROMIUM_WARM_PROFILE must be true or false")
        from auto24_service.browser_chromium import open_chromium_listing, sweep_leftovers
        from auto24_service.captcha.extension_wait import EXTENSION
        from auto24_service.captcha.reveal import reveal_registration

        sweep_leftovers(Path(tempfile.gettempdir()))
        # The extension solves; the reveal only watches it.
        capture = functools.partial(
            capture_listing, solver=EXTENSION, force_failure=force_failure,
            opener=open_chromium_listing, reveal=reveal_registration, engine=engine,
        )
        if warm_setting == "true":
            capture = warm_capture(capture, WarmProfile(Path(tempfile.gettempdir()) / "a24-warm"))
    else:
        try:
            use_lookup = parse_lookup_enabled(os.environ.get("CAPTCHA_LOOKUP_ENABLED"))
        except ValueError as exc:
            argument_parser.error(str(exc))
        solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
        try:
            verify_solver_dir(solver_dir)
        except (SolverFilesError, OSError, ValueError) as exc:
            argument_parser.error(f"CAPTCHA_SOLVER_DIR verification failed: {exc}")
        try:
            solver = load_solver(solver_dir, use_lookup=use_lookup)
        except Exception as exc:
            argument_parser.error(f"CAPTCHA_SOLVER_DIR could not be loaded: {type(exc).__name__}: {exc}")
        capture = functools.partial(capture_listing, solver=solver, force_failure=force_failure)

    logging.basicConfig(level=logging.INFO)
    diagnostics_enabled = os.environ.get("LIVE_DIAGNOSTICS_ENABLED", "false").lower() == "true"
    options = {"diagnostics_enabled": True} if diagnostics_enabled else {}
    with StorageClient(storage_url, internal_key) as client:
        if arguments.once:
            run_once(client, capture, parse_listing, **options)
        else:
            run_forever(client, capture, parse_listing, **options)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
