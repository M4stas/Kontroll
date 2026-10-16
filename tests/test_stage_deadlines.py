"""Fast monotonic-clock regressions for stalled browser stages."""
import random
from types import SimpleNamespace

import pytest

from auto24_service.captcha import recaptcha, reveal


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


class Page:
    url = 'https://www.auto24.ee/soidukid/1'

    def __init__(self, clock):
        self.clock = clock

    def wait_for_timeout(self, ms):
        self.clock.now += ms / 1000


def driver():
    clock = Clock()
    page = Page(clock)
    return recaptcha._Driver(page, None, 90, 3, clock, random.Random(1), None), clock


def test_debug_capture_near_stage_expiry_uses_remaining_inactivity_budget(monkeypatch):
    d, clock = driver()
    challenge = recaptcha.Challenge('/m/01', None, 3, 'imageselect', [])
    budgets = []
    monkeypatch.setattr(d, 'newest_challenge', lambda: (1, challenge) if clock() >= 12 else None)
    monkeypatch.setattr(d, 'challenge_visible', lambda: False)
    monkeypatch.setattr(d, 'passed', lambda: False)
    monkeypatch.setattr(d, 'watch_anchor', d.wait)
    monkeypatch.setattr(d, 'anchor', lambda: None)
    monkeypatch.setattr(d, 'bframe', lambda: None)

    def capture(event, page, info):
        if event == 'captcha_state_wait' and clock() >= 30:
            budgets.append(info['left_s'])
            clock.now += min(5, max(0, info['left_s']))

    d.debug_hook = capture
    with pytest.raises(recaptcha._Deadline):
        d.wait_for_state()
    assert budgets and 0 < budgets[-1] <= 2.2
    assert 31.7 <= clock() <= 32.3


def test_silent_checkbox_state_stops_after_twenty_seconds(monkeypatch):
    d, clock = driver()
    monkeypatch.setattr(d, 'challenge_visible', lambda: False)
    monkeypatch.setattr(d, 'passed', lambda: False)
    monkeypatch.setattr(d, 'watch_anchor', d.wait)
    with pytest.raises(recaptcha._Deadline):
        d.wait_for_state()
    assert 19.7 <= clock() <= 20.1


def test_silent_verification_stops_after_twenty_seconds(monkeypatch):
    d, clock = driver()
    monkeypatch.setattr(d, 'verify_outcome', lambda after: None)
    monkeypatch.setattr(d, 'try_again_later', lambda: False)
    monkeypatch.setattr(d, 'visible', lambda *args: False)
    monkeypatch.setattr(d, 'anchor_checked', lambda: False)
    monkeypatch.setattr(d, 'challenge_visible', lambda: True)
    monkeypatch.setattr(d, 'src', lambda img: 'same')
    frame = SimpleNamespace(is_detached=lambda: False)
    tiles = SimpleNamespace(count=lambda: 1, first=SimpleNamespace(locator=lambda s: None))
    with pytest.raises(recaptcha._Deadline):
        d.wait_for_verify(frame, tiles, dict(responses=0, incorrect=False, select_more=False, src='same'))
    assert 19.7 <= clock() <= 20.1


def test_stuck_trigger_click_is_capped_at_twenty_seconds(monkeypatch):
    clock = Clock()
    page = Page(clock)
    seen = []

    def click(selector, timeout):
        seen.append(timeout)
        raise RuntimeError('stuck')

    page.click = click
    monkeypatch.setattr(reveal, '_read_row', lambda *args: reveal._Row(True, True, None, ''))
    attempt = reveal._Attempt(SimpleNamespace(page=page), None, 90, clock, None)
    with pytest.raises(RuntimeError):
        attempt.reveal(reveal._FIELDS[0])
    assert seen == [20000]


def test_first_attempt_reserves_retry_after_navigation(monkeypatch):
    clock = Clock()
    clock.now = 14  # initial navigation already consumed time
    seen = []
    monkeypatch.setattr(reveal, '_initial_state', lambda page: {'reg_number': ('hidden', None), 'vin': ('not_listed', None)})

    def run(number, session, pending, revealed, solver, seconds, *args, **kwargs):
        seen.append((number, seconds))
        clock.now += seconds + 0.5  # bookkeeping after full expiry
        return SimpleNamespace()

    monkeypatch.setattr(reveal, '_run_attempt', run)
    monkeypatch.setattr(reveal, '_second_attempt', lambda reopen, pending, revealed, solver, seconds, *args, **kwargs: run(2, None, pending, revealed, solver, seconds))
    monkeypatch.setattr(reveal, 'RevealDiagnostics', lambda **kwargs: kwargs)
    reveal.reveal_registration(SimpleNamespace(page=None), None, None, clock=clock, deadline=120)
    assert seen == [(1, 70), (2, 30.5)]


def test_short_capture_budget_still_runs_one_useful_attempt(monkeypatch):
    clock = Clock()
    seen = []
    monkeypatch.setattr(reveal, '_initial_state', lambda page: {'reg_number': ('hidden', None), 'vin': ('not_listed', None)})

    def run(number, session, pending, revealed, solver, seconds, *args, **kwargs):
        seen.append((number, session is not None, seconds))
        clock.now += seconds
        return SimpleNamespace()

    monkeypatch.setattr(reveal, '_run_attempt', run)
    monkeypatch.setattr(reveal, 'RevealDiagnostics', lambda **kwargs: kwargs)
    reveal.reveal_registration(SimpleNamespace(page=None), None, None, clock=clock, deadline=20)
    assert seen == [(1, True, 20), (2, False, 0)]


def test_new_challenge_progress_extends_wait_but_repeated_data_does_not(monkeypatch):
    d, clock = driver()
    challenge = recaptcha.Challenge('/m/01', None, 3, 'imageselect', [])
    monkeypatch.setattr(d, 'newest_challenge', lambda: (int(clock()), challenge) if clock() >= 15 else None)
    monkeypatch.setattr(d, 'challenge_visible', lambda: False)
    monkeypatch.setattr(d, 'passed', lambda: False)
    monkeypatch.setattr(d, 'watch_anchor', d.wait)
    with pytest.raises(recaptcha._Deadline):
        d.wait_for_state()
    assert 34.7 <= clock() <= 35.3


def test_solver_time_is_not_counted_as_checkbox_inactivity(monkeypatch):
    d, clock = driver()
    clock.now = 50  # inference/normal work before entering this stage
    monkeypatch.setattr(d, 'challenge_visible', lambda: False)
    monkeypatch.setattr(d, 'passed', lambda: clock() >= 65)
    monkeypatch.setattr(d, 'watch_anchor', d.wait)
    assert d.wait_for_state() == 'passed'
    assert clock() < 66


def test_silent_value_appearance_has_its_own_stage_bound(monkeypatch):
    clock = Clock()
    page = Page(clock)
    page.click = lambda *args, **kwargs: None
    monkeypatch.setattr(reveal, '_read_row', lambda *args: reveal._Row(True, True, None, ''))
    monkeypatch.setattr(reveal, '_captcha_shown', lambda *args: False)
    attempt = reveal._Attempt(SimpleNamespace(page=page), None, 90, clock, None)
    with pytest.raises(reveal._Fail, match='timeout'):
        attempt.reveal(reveal._FIELDS[0])
    assert 19.7 <= clock() <= 20.1


def test_registration_is_kept_and_only_vin_retried_after_timeout(monkeypatch):
    from contextlib import contextmanager
    clock = Clock()
    fields = []
    page = SimpleNamespace(on=lambda *a: None, remove_listener=lambda *a: None)
    session = SimpleNamespace(page=page, blocked=[])
    monkeypatch.setattr(reveal, '_initial_state', lambda page: {'reg_number': ('hidden', None), 'vin': ('hidden', None)})

    def value(attempt, field):
        fields.append(field.name)
        if field.name == 'reg_number':
            return '123ABC'
        attempt.stage = 'value_wait'
        raise reveal._Fail('timeout')

    @contextmanager
    def reopen():
        yield session

    monkeypatch.setattr(reveal._Attempt, 'reveal', value)
    result = reveal.reveal_registration(session, reopen, None, clock=clock, deadline=120)
    assert result.registration.reg_number == '123ABC'
    assert result.registration.reg_number_status == 'revealed'
    assert result.registration.vin_status == 'unavailable'
    assert fields == ['reg_number', 'vin', 'vin']


def test_waiting_for_replacement_challenge_is_bounded(monkeypatch):
    d, clock = driver()
    d.awaiting_new = 'same'
    monkeypatch.setattr(d, 'newest_challenge', lambda: None)
    monkeypatch.setattr(d, 'try_again_later', lambda: False)
    monkeypatch.setattr(d, 'src', lambda img: 'same')
    first = SimpleNamespace(count=lambda: 1)
    frame = SimpleNamespace(locator=lambda s: SimpleNamespace(first=first))
    monkeypatch.setattr(d, 'bframe', lambda: frame)
    with pytest.raises(recaptcha._Deadline):
        d._play({})
    assert 19.7 <= clock() <= 20.1


def test_retry_opener_receives_attempt_deadline_and_shutdown_counts(monkeypatch):
    from contextlib import contextmanager
    from datetime import datetime, timezone
    clock = Clock()
    seen = []
    session = SimpleNamespace(page=SimpleNamespace(on=lambda *a: None, remove_listener=lambda *a: None), blocked=[])

    @contextmanager
    def reopen(*, deadline=None):
        seen.append(deadline)
        clock.now += 4  # retry launch/navigation
        yield session
        clock.now += 2  # shutdown is inside thread/join budget

    monkeypatch.setattr(reveal._Attempt, 'reveal', lambda self, f: '123ABC')
    revealed = {}
    record = reveal._reopened_attempt(reopen, [reveal._FIELDS[0]], revealed, None, 30, clock, None, (datetime.now(timezone.utc), 0))
    assert seen == [30]
    assert clock() == 6
    assert record.outcome == 'no_captcha_needed'
    assert revealed == {'reg_number': '123ABC'}


def test_nested_checkbox_locator_uses_stage_deadline(monkeypatch):
    d, clock = driver()
    seen = []
    box = SimpleNamespace(bounding_box=lambda **kwargs: seen.append(kwargs['timeout']))
    # Clicking a locator outside another stage still has a bounded browser wait.
    with pytest.raises(recaptcha._End):
        d.click(box)
    assert seen == [20000]


def test_validated_field_response_extends_value_wait_once(monkeypatch):
    clock = Clock()
    page = Page(clock)
    page.click = lambda *args, **kwargs: None
    monkeypatch.setattr(reveal, '_read_row', lambda *args: reveal._Row(True, True, None, ''))
    monkeypatch.setattr(reveal, '_captcha_shown', lambda *args: False)
    monkeypatch.setattr(reveal._Attempt, 'json_value', lambda self, f: '123ABC' if clock() >= 15 else None)
    attempt = reveal._Attempt(SimpleNamespace(page=page), None, 90, clock, None)
    with pytest.raises(reveal._Fail, match='timeout'):
        attempt.reveal(reveal._FIELDS[0])
    assert 34.7 <= clock() <= 35.3
