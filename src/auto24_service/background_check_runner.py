"""Execute background checks without browser or database imports."""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from . import budget
from .mnt_lookup import LookupFailed, LookupOutcome
from .storage_client import StorageClient
from .storage_models import BackgroundCheckFinish, ClaimedBackgroundCheck

# Keep existing capture worker log consumers working.
_LOGGER = logging.getLogger("auto24_service.worker")
LookupBackgroundCheck = Callable[..., LookupOutcome]
DEFAULT_BACKGROUND_CHECK_DIR = Path("/data/background-checks")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def capture_deadline(lease_left: float) -> float:
    return budget.capture_deadline(lease_left)


def _keep_pdf(directory: Path, job_id: str, pdf: bytes) -> Path:
    """Write the PDF under a temporary name, then rename it into place."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{job_id}.pdf"
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=f".{job_id}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(pdf)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return target


def _lookup_finish(
    claim: ClaimedBackgroundCheck, lookup: LookupBackgroundCheck, directory: Path
) -> BackgroundCheckFinish:
    deadline = capture_deadline((claim.deadline - _utcnow()).total_seconds())
    try:
        outcome = lookup(claim.search_kind, claim.value, deadline)
    except LookupFailed as exc:
        try:
            return BackgroundCheckFinish(status="unavailable", reason=exc.reason,
                                         searched_by=exc.searched_by)
        except ValueError:
            return BackgroundCheckFinish(status="unavailable", reason="browser_crash")
    except Exception:
        return BackgroundCheckFinish(status="unavailable", reason="browser_crash")
    if outcome.status != "fetched":
        try:
            return BackgroundCheckFinish(status=outcome.status, reason=outcome.reason,
                                         searched_by=outcome.searched_by)
        except ValueError:
            return BackgroundCheckFinish(status="unavailable", reason="browser_crash")
    if not outcome.pdf or outcome.searched_by is None:
        return BackgroundCheckFinish(status="unavailable", reason="browser_crash")
    try:
        path = _keep_pdf(directory, claim.job_id, outcome.pdf)
    except OSError:
        return BackgroundCheckFinish(status="unavailable", reason="pdf_rejected",
                                     searched_by=outcome.searched_by)
    return BackgroundCheckFinish(
        status="fetched", searched_by=outcome.searched_by, pdf_path=str(path),
        size_bytes=len(outcome.pdf), sha256=hashlib.sha256(outcome.pdf).hexdigest(),
    )


def run_background_check(
    client: StorageClient, lookup: LookupBackgroundCheck, directory: Path, engine: str = "chromium"
) -> bool:
    """Claim and run at most one lookup; return whether one was claimed."""
    try:
        claim = client.claim_background_check()
    except Exception as exc:
        # A storage without lookup routes, or a failing one, must not stop captures.
        _LOGGER.warning("action=background_check_claim_failed error=%s", type(exc).__name__)
        return False
    if claim is None:
        return False
    finish = _lookup_finish(claim, lookup, directory)
    try:
        updated = client.finish_background_check(claim.job_id, claim.lease_token, finish)
    except BaseException:
        if finish.pdf_path is not None:
            Path(finish.pdf_path).unlink(missing_ok=True)
        raise
    if not updated and finish.pdf_path is not None:
        Path(finish.pdf_path).unlink(missing_ok=True)
    # Statuses only: the search value and PDF text never go into logs.
    _LOGGER.info(
        "job_id=%s background_check=%s engine=%s reason=%s%s", claim.job_id, finish.status, engine,
        finish.reason or "none", "" if updated else " action=rejected",
    )
    return True


