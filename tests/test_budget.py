import pytest

from auto24_service import budget
from auto24_service.store import REVEAL_SECONDS


def at(now):
    return lambda: now


def test_capture_deadline_keeps_the_lease_safety_margin():
    assert budget.capture_deadline(100, clock=at(1000.0)) == 1085.0


def test_reveal_after_completion_gets_the_storage_window_less_the_margin():
    assert REVEAL_SECONDS == 120
    assert budget.reveal_deadline_after_completion(clock=at(1000.0)) == 1105.0


@pytest.mark.parametrize("attempt, reveal, expected", [
    (None, None, None),
    (30.0, None, 30.0),
    (None, 1105.0, 1105.0),
    (1050.0, 1105.0, 1050.0),
    (1200.0, 1105.0, 1105.0),
])
def test_retry_deadline_is_the_earlier_one(attempt, reveal, expected):
    assert budget.retry_deadline(attempt, reveal) == expected


@pytest.mark.parametrize("left, expected", [
    (None, 90.0),  # no deadline: the full attempt
    (150.0, 90.0),  # room for attempt 1 and a 30 s retry
    (100.0, 64.0),  # 100 - 30 (retry) - 5 (join) - 1 (handoff)
    (46.0, 10.0),  # the smallest attempt 1 that still leaves a retry
    (45.0, 45.0),  # no useful retry fits: spend it all at once
    (10.0, 10.0),
    (9.9, None),  # too short to start
])
def test_first_attempt_slice(left, expected):
    deadline = None if left is None else 1000.0 + left
    result = budget.first_attempt_seconds(90.0, deadline, at(1000.0))
    assert result is None if expected is None else result == pytest.approx(expected)


def test_first_attempt_without_deadline_is_never_skipped():
    assert budget.first_attempt_seconds(5.0, None, at(0.0)) == 5.0


@pytest.mark.parametrize("left, expected", [
    (None, 90.0),
    (200.0, 90.0),
    (60.0, 55.0),  # less the 5 s join margin
    (35.0, 30.0),
    (34.9, None),  # under the 30 s floor for a retry
])
def test_second_attempt_slice(left, expected):
    deadline = None if left is None else 1000.0 + left
    result = budget.second_attempt_seconds(90.0, deadline, at(1000.0))
    assert result is None if expected is None else result == pytest.approx(expected)


def test_join_waits_past_the_attempt_budget():
    assert budget.join_seconds(90.0) == 95.0


def test_kill_after_deadline_plus_grace():
    assert budget.kill_after_seconds(1010.0, clock=at(1000.0)) == 15.0
    assert budget.kill_after_seconds(990.0, clock=at(1000.0)) == 5.0


def test_default_clock_follows_a_patched_monotonic(monkeypatch):
    monkeypatch.setattr(budget.time, "monotonic", lambda: 500.0)
    assert budget.capture_deadline(60) == 545.0
