"""The fixed interfaces that open listing sessions for a capture and its retry."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from auto24_service.diagnostics import NULL_OBSERVER, PhaseObserver

if TYPE_CHECKING:
    from auto24_service.browser import ListingSession


@dataclass(frozen=True)
class ListingOpener:
    """Opens a listing session for capture_listing.

    `open` is always called as `open(url, *, profile_dir, deadline, keep_profile,
    observer)`, so it must accept every one of those. `same_thread` says the
    session belongs to the calling thread's Playwright, so a retry must run on
    that thread instead of one of its own.
    """

    open: Callable[..., AbstractContextManager[ListingSession]]
    same_thread: bool

    def __call__(
        self,
        url: str,
        *,
        profile_dir: Path | None = None,
        deadline: float | None = None,
        keep_profile: Path | None = None,
        observer: PhaseObserver = NULL_OBSERVER,
    ) -> AbstractContextManager[ListingSession]:
        return self.open(url, profile_dir=profile_dir, deadline=deadline, keep_profile=keep_profile,
                         observer=observer)


@dataclass(frozen=True)
class RetryOpener:
    """Opens the fresh session for reveal attempt 2.

    `open` is always called as `open(*, deadline)`, with the attempt's deadline.
    `same_thread` has the same meaning as on ListingOpener.
    """

    open: Callable[..., AbstractContextManager[ListingSession]]
    same_thread: bool

    def __call__(self, *, deadline: float) -> AbstractContextManager[ListingSession]:
        return self.open(deadline=deadline)
