"""Worker-local Chromium profile bookkeeping and reset rules."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Callable

from .contracts import RevealDiagnostics


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
        self.jobs = 0

    def path(self) -> Path:
        """Create the current generation on first use and return its folder."""
        path = self._root / f"profile-{self._generation}"
        if self._created_at is None:
            path.mkdir()
            self._created_at = self._clock()
        return path

    def record(self, blocked: bool) -> str | None:
        """Count a finished job and discard its profile when a limit is reached."""
        self.jobs += 1
        if blocked:
            reason = "blocked"
        elif self.jobs >= self._max_jobs:
            reason = "count"
        elif self._created_at is not None and self._clock() - self._created_at >= self._max_age_s:
            reason = "age"
        else:
            return None

        path = self._root / f"profile-{self._generation}"
        if path.exists():
            shutil.rmtree(path)
        self._generation += 1
        self._created_at = None
        self.jobs = 0
        return reason


def is_blocked(error_code: str | None, diagnostics: RevealDiagnostics | None) -> bool:
    """Recognize capture and reveal signals that require a fresh profile."""
    return error_code == "access_blocked" or (
        diagnostics is not None
        and any(attempt.reason == "try_again_later" for attempt in diagnostics.attempts)
    )
