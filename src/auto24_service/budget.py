"""The time budget from a job lease to the end of the registration reveal.

Every deadline here is a `clock()` value, `time.monotonic()` by default. The worker
turns the lease into a capture deadline, the capture hands the reveal its deadline,
and the reveal splits that into attempt budgets. Callers ask for their slice here
instead of subtracting margins themselves.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from auto24_service.contracts import REVEAL_SECONDS

# The capture must end this long before the lease does, leaving time to parse and
# call complete() while the lease token is still valid. The reveal after completion
# keeps the same margin before its storage window closes.
LEASE_SAFETY_SECONDS = 15.0
# Attempt 2 runs on its own thread; the join waits this long past its budget.
JOIN_MARGIN_SECONDS = 5.0
HANDOFF_MARGIN_SECONDS = 1.0
# Below these budgets an attempt cannot finish a CAPTCHA, so it is recorded as a
# timeout instead of started. Attempt 2 also has to launch a browser and navigate.
MIN_ATTEMPT_SECONDS = 10.0
MIN_SECOND_ATTEMPT_SECONDS = 30.0
# open_chromium_session kills Chromium this long after its deadline.
SESSION_KILL_GRACE_S = 5

Clock = Callable[[], float]


def _monotonic() -> float:
    # Looked up on each call so a patched time.monotonic is honoured.
    return time.monotonic()


def capture_deadline(lease_left: float, clock: Clock = _monotonic) -> float:
    """The capture deadline with `lease_left` seconds remaining on the lease."""
    return clock() + lease_left - LEASE_SAFETY_SECONDS


def reveal_deadline_after_completion(clock: Clock = _monotonic) -> float:
    """The reveal deadline once the job is complete and the lease no longer bounds it."""
    return clock() + REVEAL_SECONDS - LEASE_SAFETY_SECONDS


def retry_deadline(attempt_deadline: float | None, reveal_deadline: float | None) -> float | None:
    """The deadline a retry session opens with: the earlier of the two, if any."""
    if attempt_deadline is None and reveal_deadline is None:
        return None
    return min(d for d in (attempt_deadline, reveal_deadline) if d is not None)


def _fit(attempt_seconds: float, deadline: float | None, clock: Clock, margin: float) -> float:
    if deadline is None:
        return attempt_seconds
    return min(attempt_seconds, deadline - clock() - margin)


def first_attempt_seconds(attempt_seconds: float, deadline: float | None, clock: Clock = _monotonic) -> float | None:
    """Attempt 1's budget, or None when too little is left to start it.

    It leaves room for a useful attempt 2 when it can; otherwise it spends the rest.
    """
    seconds = _fit(attempt_seconds, deadline, clock,
                   MIN_SECOND_ATTEMPT_SECONDS + JOIN_MARGIN_SECONDS + HANDOFF_MARGIN_SECONDS)
    if seconds < MIN_ATTEMPT_SECONDS:
        # Reserving a useful retry is impossible: spend the budget once.
        seconds = _fit(attempt_seconds, deadline, clock, 0.0)
    if deadline is not None and seconds < MIN_ATTEMPT_SECONDS:
        return None
    return seconds


def second_attempt_seconds(attempt_seconds: float, deadline: float | None, clock: Clock = _monotonic) -> float | None:
    """Attempt 2's budget, or None when too little is left to start it."""
    seconds = _fit(attempt_seconds, deadline, clock, JOIN_MARGIN_SECONDS)
    if deadline is not None and seconds < MIN_SECOND_ATTEMPT_SECONDS:
        return None
    return seconds


def join_seconds(attempt_seconds: float) -> float:
    """How long to wait for an attempt running on its own thread."""
    return attempt_seconds + JOIN_MARGIN_SECONDS


def kill_after_seconds(deadline: float, clock: Clock = _monotonic) -> float:
    """Seconds from now until a session past `deadline` is killed."""
    return max(0.0, deadline - clock()) + SESSION_KILL_GRACE_S
