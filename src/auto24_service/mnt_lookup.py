"""Entry point and outcome type for Transpordiamet background check lookups.

The page driver that searches eteenindus.mnt.ee and presses "Salvestan" is not built
yet. Until it is, every lookup ends as unavailable with reason site_changed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .contracts import BackgroundCheckReason, SearchKind


@dataclass(frozen=True)
class LookupOutcome:
    """A lookup's final result. `pdf` holds the downloaded file when fetched."""

    status: Literal["fetched", "not_found", "unavailable"]
    searched_by: SearchKind | None = None
    reason: BackgroundCheckReason | None = None
    pdf: bytes | None = None


class LookupFailed(Exception):
    """The lookup ended without a result; `reason` is the state's unavailable reason."""

    def __init__(self, reason: BackgroundCheckReason, searched_by: SearchKind | None = None):
        super().__init__(reason)
        self.reason = reason
        self.searched_by = searched_by


def lookup_background_check(
    search_kind: SearchKind, value: str, deadline: float, *, keep_profile: Path | None = None,
) -> LookupOutcome:
    """Search by one identity value and download the PDF before `deadline` (time.monotonic())."""
    raise LookupFailed("site_changed")
