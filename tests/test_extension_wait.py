"""Plan A reveal on Chromium: the stub extension solves, Python only watches.

Requires the pinned Chromium image. All values are fake.
"""
import functools
import json
import os
import signal
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

if not Path(os.environ.get('CHROMIUM_EXECUTABLE', '/missing')).is_file():
    pytest.skip('Chromium image only', allow_module_level=True)

from auto24_service.browser import capture_listing
from auto24_service.browser_chromium import open_chromium_listing
from auto24_service.captcha.extension_wait import EXTENSION, watch_extension
from auto24_service.captcha.reveal import reveal_registration
from tests.fakesite import LISTING_URL, Scenario, install_fake_site

STUB = Path('/app/tests/fixtures/stub-extension')
REG = '123ABC'
VIN = 'WVWZZZ1KZAW000001'


def run(first, second=None, *, before=None, **kwargs):
    """Reveal with the stub extension; `second` is the scenario the retry session gets."""
    logs = []

    def opened(scenario, **options):
        return open_chromium_listing(
            LISTING_URL, setup=lambda c: logs.append(install_fake_site(c, scenario)),
            extension_dir=STUB, **options,
        )

    @contextmanager
    def reopen(**options):
        with opened(second or first, **options) as session:
            if before is not None:
                before(session)
            yield session

    with opened(first) as session:
        if before is not None:
            before(session)
        started = time.monotonic()
        outcome = reveal_registration(session, reopen, EXTENSION, **kwargs)
        elapsed = time.monotonic() - started
    return outcome, logs, elapsed


def statuses(outcome):
    r = outcome.registration
    return r.reg_number_status, r.vin_status


def test_reveals_both_values_and_records_extension_rounds():
    outcome, logs, _ = run(Scenario())
    r = outcome.registration
    assert (r.reg_number, r.reg_number_status) == (REG, 'revealed')
    assert (r.vin, r.vin_status) == (VIN, 'revealed')
    (attempt,) = outcome.diagnostics.attempts
    assert (attempt.outcome, attempt.reason, attempt.stage) == ('revealed', None, 'done')
    assert attempt.solver == 'extension' and attempt.checkbox_only is False
    (rnd,) = attempt.rounds
    assert rnd.solver == 'extension' and rnd.result == 'solved'
    assert rnd.tiles == [] and rnd.grid == '3x3' and rnd.label == 'cars'
    assert not rnd.incomplete
    assert attempt.prefix_check == {'reg_number': 'passed', 'vin': 'passed'}
    text = outcome.diagnostics.model_dump_json()
    assert REG not in text and VIN not in text


def test_repeated_replies_for_one_challenge_count_once():
    outcome, logs, _ = run(Scenario(repeat_replies=3))
    assert logs[0].reloads == 3  # the same challenge came back three times
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == 'revealed'
    assert len(attempt.rounds) == 1


def test_dynamic_refills_stay_in_one_round():
    outcome, logs, _ = run(Scenario(grid='3x3_dynamic'))
    assert any('&id=' in url for url in logs[0].requests)  # tiles were refilled
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == 'revealed'
    (rnd,) = attempt.rounds
    assert rnd.grid == '3x3_dynamic' and rnd.result == 'solved'


def test_three_failed_rounds_give_rounds_exhausted():
    ids = ['fake-c-1', 'fake-c-2', 'fake-c-3', 'fake-c-4']
    outcome, _, _ = run(Scenario(incorrect_rounds=3, challenge_ids=ids))
    first, second = outcome.diagnostics.attempts
    for attempt in (first, second):
        assert (attempt.outcome, attempt.reason) == ('failed', 'captcha_rounds_exhausted')
        assert [rnd.result for rnd in attempt.rounds] == ['incorrect'] * 3
        assert all(rnd.solver == 'extension' for rnd in attempt.rounds)
    assert statuses(outcome) == ('unavailable', 'unavailable')


def test_no_progress_for_20_s_is_a_stall_timeout():
    started = time.monotonic()
    outcome, _, _ = run(Scenario(silent_after_s=0), deadline=started + 75)
    first, second = outcome.diagnostics.attempts
    assert (first.outcome, first.reason, first.stage) == ('failed', 'timeout', 'stall')
    assert 20_000 <= first.duration_ms < 25_000
    # The retry still runs a real attempt inside the lease.
    assert (second.reason, second.stage) == ('timeout', 'stall')
    assert time.monotonic() <= started + 75
    assert statuses(outcome) == ('unavailable', 'unavailable')


CHATTER = '''() => setInterval(() => {
    fetch('/services/data_json.php?q=noop&k=x');
    fetch('https://www.google.com/recaptcha/api2/payload?p=0&k=x', {mode: 'no-cors'});
}, 300)'''


def test_chatter_does_not_reset_the_stall_timer():
    logs = []
    with open_chromium_listing(LISTING_URL, setup=lambda c: logs.append(install_fake_site(c, Scenario(silent_after_s=0))),
                               extension_dir=STUB) as session:
        page = session.page
        page.click('.service-trigger[data-action="uv_regnr"]')
        page.wait_for_selector('.germ')
        page.evaluate(CHATTER, isolated_context=False)
        started = time.monotonic()
        result = watch_extension(page, deadline=started + 30, rounds_left=3, stall_s=3)
        elapsed = time.monotonic() - started
    assert (result.passed, result.reason, result.stage) == (False, 'timeout', 'stall')
    assert 3 <= elapsed < 5
    assert sum('q=noop' in url for url in logs[0].requests) >= 5
    assert sum('payload?p=0&k=x' in url for url in logs[0].requests) >= 5


def test_unknown_reply_format_marks_incomplete_but_keeps_the_value():
    outcome, _, _ = run(Scenario(unknown_replies=True))
    assert statuses(outcome) == ('revealed', 'revealed')
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == 'revealed' and attempt.reason is None
    (rnd,) = attempt.rounds
    assert rnd.incomplete and rnd.solver == 'extension'


def test_try_again_later_is_reported():
    outcome, _, _ = run(Scenario(try_again_later=True))
    assert [a.reason for a in outcome.diagnostics.attempts] == ['try_again_later', 'try_again_later']
    assert statuses(outcome) == ('unavailable', 'unavailable')


def test_worker_restart_during_attempt_does_not_hang():
    states = []

    def stop_worker(event, page, info):
        if event != 'trigger_clicked' or states:
            return
        cdp = page.context.new_cdp_session(page)
        cdp.on('ServiceWorker.workerVersionUpdated',
               lambda e: states.extend(v['runningStatus'] for v in e['versions']))
        cdp.send('ServiceWorker.enable')
        cdp.send('ServiceWorker.stopAllWorkers')
        end = time.monotonic() + 5
        while 'stopped' not in states and time.monotonic() < end:
            page.wait_for_timeout(50)

    outcome, _, elapsed = run(Scenario(), attempt_seconds=90, debug=stop_worker)
    assert 'stopped' in states
    assert elapsed < 90 + 35
    attempt = outcome.diagnostics.attempts[0]
    assert attempt.outcome == 'revealed' or attempt.reason is not None
    # The content script's message woke the worker again.
    assert 'running' in states[states.index('stopped'):]


def test_listed_in_full_needs_no_wait():
    outcome, logs, elapsed = run(Scenario(reg='full', vin='full'))
    assert statuses(outcome) == ('listed_in_full', 'listed_in_full')
    assert outcome.diagnostics.attempts == []
    assert elapsed < 2


def test_value_checks_unchanged():
    outcome, _, _ = run(Scenario(reg_page_value='456DEF'))
    assert [a.reason for a in outcome.diagnostics.attempts] == ['value_rejected', 'value_rejected']
    assert statuses(outcome) == ('unavailable', 'revealed')
    outcome, _, _ = run(Scenario(reg_prefix='999...'))
    assert [a.reason for a in outcome.diagnostics.attempts] == ['prefix_mismatch', 'prefix_mismatch']
    assert statuses(outcome) == ('unavailable', 'revealed')


def _kill_sessions(root: Path):
    for marker in root.glob('a24-chromium-*/chrome.json'):
        try:
            os.killpg(json.loads(marker.read_text())['pid'], signal.SIGKILL)
        except (OSError, ValueError, KeyError):
            pass


def test_chromium_crash_mid_reveal_completes_the_capture(tmp_path, monkeypatch):
    # Both attempts' profiles live under tmp_path, so the kill finds each Chromium.
    monkeypatch.setattr(tempfile, 'tempdir', str(tmp_path))
    events = []

    def crash(event, page, info):
        events.append(event)
        if event == 'trigger_clicked':
            _kill_sessions(tmp_path)

    opener = functools.partial(
        open_chromium_listing, setup=lambda c: install_fake_site(c, Scenario()), extension_dir=STUB,
    )
    started = time.monotonic()
    result = capture_listing(LISTING_URL, solver=EXTENSION, engine='chromium', opener=opener,
                             profile_dir=tmp_path, debug=crash, deadline=started + 150)
    assert 'Skoda Enyaq' in result.html
    assert (result.registration.reg_number_status, result.registration.vin_status) == ('unavailable', 'unavailable')
    assert events.count('trigger_clicked') >= 1
    for attempt in result.reveal_diagnostics.attempts:
        assert attempt.outcome == 'failed' and attempt.reason in ('browser_error', 'timeout')
    assert result.reveal_diagnostics.engine == 'chromium'


def test_debug_screenshots_mask_values_on_chromium(tmp_path):
    from PIL import Image

    from auto24_service.captcha import debug as debug_mod

    calls = []
    recorder = debug_mod.DebugRecorder(tmp_path)

    def spy(event, page, info):
        if event == 'attempt_end':
            calls.append(page.locator(debug_mod.MASKED_SELECTORS[0]).bounding_box())
        recorder(event, page, info)

    outcome, _, _ = run(Scenario(), debug=spy)
    assert outcome.registration.reg_number_status == 'revealed'
    box = calls[-1]
    png = sorted(tmp_path.glob('*attempt_end.png'))[-1]
    with Image.open(png) as img:
        x0, y0 = int(box['x']) + 1, int(box['y']) + 1
        x1, y1 = int(box['x'] + box['width']) - 1, int(box['y'] + box['height']) - 1
        colours = img.convert('RGB').crop((x0, y0, x1, y1)).getcolors()
    assert colours is not None and len(colours) == 1 and colours[0][1] == (0, 0, 0)
