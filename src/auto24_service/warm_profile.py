"""Worker-local Chromium profile bookkeeping and reset rules."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Callable

from .contracts import Registration, RevealDiagnostics


class WarmProfile:
    """Keep one profile generation until a finished job requires a reset."""

    def __init__(
        self,
        root: Path,
        *,
        max_jobs: int = 30,
        max_age_s: float = 36_000,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True)
        self._root = root
        self._max_jobs = max_jobs
        self._max_age_s = max_age_s
        self._clock = clock
        self._generation = 0
        self._created_at: float | None = None
        self._temporary_failures = 0
        self.jobs = 0

    def path(self) -> Path:
        """Create the current generation on first use and return its folder."""
        path = self._root / f"profile-{self._generation}"
        if self._created_at is None:
            path.mkdir()
            self._created_at = self._clock()
        return path

    def record_outcome(
        self, error_code: str | None = None,
        diagnostics: RevealDiagnostics | None = None,
        registration: Registration | None = None,
    ) -> str | None:
        """Count one capture, including consecutive temporary failures."""
        self._temporary_failures = self._temporary_failures + 1 if error_code == "temporary_failure" else 0
        reason = outcome_reason(error_code, diagnostics, registration)
        if reason is None and self._temporary_failures >= 2:
            reason = "temporary"
        return self._record(reason)

    def record(self, blocked: bool) -> str | None:
        """Record a legacy blocked or ordinary outcome."""
        return self.record_outcome("access_blocked" if blocked else None)

    def _record(self, reason: str | None) -> str | None:
        self.jobs += 1
        if reason is None:
            if self.jobs >= self._max_jobs:
                reason = "count"
            elif self._created_at is not None and self._clock() - self._created_at >= self._max_age_s:
                reason = "age"
            else:
                return None

        old = self._root / f"profile-{self._generation}"
        self._generation += 1
        self._created_at = None
        self._temporary_failures = 0
        self.jobs = 0
        shutil.rmtree(old, ignore_errors=True)
        return reason


def is_blocked(error_code: str | None, diagnostics: RevealDiagnostics | None) -> bool:
    """Recognize capture and reveal signals that require a fresh profile."""
    return error_code == "access_blocked" or (
        diagnostics is not None
        and any(attempt.reason == "try_again_later" for attempt in diagnostics.attempts)
    )


def outcome_reason(
    error_code: str | None,
    diagnostics: RevealDiagnostics | None,
    registration: Registration | None,
) -> str | None:
    """Classify a single capture without retaining values or diagnostics."""
    if is_blocked(error_code, diagnostics):
        return "blocked"
    if error_code in {"browser_launch", "extension_not_loaded"}:
        return "launch"
    has_value = registration is not None and any(
        getattr(registration, f"{field}_status") in {"revealed", "listed_in_full"}
        for field in ("reg_number", "vin")
    )
    if not has_value and diagnostics is not None and any(
        attempt.reason in {"captcha_rounds_exhausted", "timeout"}
        for attempt in diagnostics.attempts
    ):
        return "failed_reveal"
    return None
