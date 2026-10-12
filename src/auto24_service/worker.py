"""Process queued Auto24 listing extractions one job at a time."""

from __future__ import annotations

import argparse
import functools
import logging
import os
import time
from collections.abc import Callable, Sequence
from pathlib import Path

from auto24_service.browser import CaptureError, CaptureResult, capture_listing
from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
from auto24_service.captcha.solver import load_solver
from auto24_service.contracts import ListingResult
from auto24_service.parser import ParseError, parse_listing
from auto24_service.storage_client import StorageClient
from auto24_service.store import ClaimedJob


_ERROR_MESSAGES = {
    "listing_gone": "Listing is no longer available.",
    "access_blocked": "Access to the listing was blocked.",
    "unsupported_vehicle_type": "The listing is not for a passenger car.",
    "parse_failed": "The listing could not be parsed.",
    "temporary_failure": "The listing could not be fetched temporarily.",
}
_ERROR_CODES = frozenset(_ERROR_MESSAGES)
_LOGGER = logging.getLogger(__name__)
CaptureListing = Callable[[str], CaptureResult]
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


def _fail(client: StorageClient, claim: ClaimedJob, code: str) -> None:
    updated = client.fail(
        claim.job_id,
        claim.lease_token,
        code,
        _ERROR_MESSAGES[code],
        code == "temporary_failure",
    )
    action = "failure_recorded" if updated else "failure_rejected"
    _LOGGER.warning("job_id=%s action=%s code=%s", claim.job_id, action, code)


def run_once(
    client: StorageClient,
    capture: CaptureListing,
    parser: ParseListing,
) -> bool:
    """Claim and process at most one job; return whether a job was claimed."""
    claim = client.claim()
    if claim is None:
        return False

    try:
        captured = capture(claim.source_url)
    except Exception as exc:
        _fail(client, claim, _capture_error_code(exc))
        return True

    try:
        listing, warnings = parser(captured.html, claim.source_url)
    except Exception as exc:
        _fail(client, claim, _parse_error_code(exc))
        return True

    registration = captured.registration
    if registration is not None:
        listing.registration = registration
    updated = client.complete(
        claim.job_id,
        claim.lease_token,
        listing.model_dump(mode="json"),
        warnings,
        reveal_diagnostics=captured.reveal_diagnostics,
    )
    state = "completed" if updated else "superseded"
    # Statuses only: revealed values never go into logs.
    _LOGGER.info(
        "job_id=%s status=%s reg_number_status=%s vin_status=%s",
        claim.job_id,
        state,
        registration.reg_number_status if registration else "none",
        registration.vin_status if registration else "none",
    )
    return True


def run_forever(
    client: StorageClient,
    capture: CaptureListing,
    parser: ParseListing,
) -> None:
    """Process jobs sequentially, sleeping two seconds while the queue is idle."""
    while True:
        if not run_once(client, capture, parser):
            time.sleep(2)


def main(argv: Sequence[str] | None = None) -> int:
    argument_parser = argparse.ArgumentParser(description="Process Auto24 extraction jobs")
    argument_parser.add_argument(
        "--once", action="store_true", help="process one eligible job and exit"
    )
    arguments = argument_parser.parse_args(argv)
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
    solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    try:
        verify_solver_dir(solver_dir, solver_dir / "SHA256SUMS")
    except (SolverFilesError, OSError) as exc:
        argument_parser.error(f"CAPTCHA_SOLVER_DIR verification failed: {exc}")
    solver = load_solver(solver_dir)
    capture = functools.partial(capture_listing, solver=solver, force_failure=force_failure)

    logging.basicConfig(level=logging.INFO)
    with StorageClient(storage_url, internal_key) as client:
        if arguments.once:
            run_once(client, capture, parse_listing)
        else:
            run_forever(client, capture, parse_listing)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
