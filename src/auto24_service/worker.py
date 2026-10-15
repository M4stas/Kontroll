"""Process queued Auto24 listing extractions one job at a time."""

from __future__ import annotations

import argparse
import logging
import os
import time
from collections.abc import Callable, Sequence

from auto24_service.diagnostics import PhaseObserver, SpanRecorder, NULL_OBSERVER
from auto24_service.browser import CaptureError, capture_html
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
CaptureHTML = Callable[[str, PhaseObserver], str]
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
    capture: CaptureHTML,
    parser: ParseListing,
    *, diagnostics_enabled: bool = False,
) -> bool:
    """Claim and process at most one job; return whether a job was claimed."""
    claim = client.claim()
    if claim is None:
        return False

    recorder = SpanRecorder(
        lambda spans: client.record_spans(claim.job_id, claim.lease_token, spans, timeout=1.0),
        job_id=claim.job_id, attempt=claim.attempts,
    ) if diagnostics_enabled else None

    def finish_diagnostics():
        if recorder is not None:
            recorder.flush(.1)
            recorder.close()

    try:
        html = capture(claim.source_url, recorder) if recorder else capture(claim.source_url)
    except Exception as exc:
        finish_diagnostics()
        _fail(client, claim, _capture_error_code(exc))
        return True

    try:
        with (recorder or NULL_OBSERVER).phase("parsing"):
            listing, warnings = parser(html, claim.source_url)
    except Exception as exc:
        finish_diagnostics()
        _fail(client, claim, _parse_error_code(exc))
        return True

    finish_diagnostics()
    updated = client.complete(
        claim.job_id,
        claim.lease_token,
        listing.model_dump(mode="json"),
        warnings,
    )
    state = "completed" if updated else "superseded"
    _LOGGER.info("job_id=%s status=%s", claim.job_id, state)
    return True


def run_forever(
    client: StorageClient,
    capture: CaptureHTML,
    parser: ParseListing,
    *, diagnostics_enabled: bool = False,
) -> None:
    """Process jobs sequentially, sleeping two seconds while the queue is idle."""
    while True:
        options = {"diagnostics_enabled": True} if diagnostics_enabled else {}
        if not run_once(client, capture, parser, **options):
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

    logging.basicConfig(level=logging.INFO)
    diagnostics_enabled = os.environ.get("LIVE_DIAGNOSTICS_ENABLED", "false").lower() == "true"
    options = {"diagnostics_enabled": True} if diagnostics_enabled else {}
    with StorageClient(storage_url, internal_key) as client:
        if arguments.once:
            run_once(client, capture_html, parse_listing, **options)
        else:
            run_forever(client, capture_html, parse_listing, **options)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
