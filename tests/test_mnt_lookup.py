"""MNT background check driver against fake Transpordiamet pages. Chromium image only.

All values are fake. The fake pages copy the ids, texts and flow of the user's recon
session on 2026-10-22, not its content.
"""
import os
from pathlib import Path

import pytest

if not Path(os.environ.get('CHROMIUM_EXECUTABLE', '/missing')).is_file():
    pytest.skip('Chromium image only', allow_module_level=True)

import time
from dataclasses import replace

from auto24_service.browser_chromium import open_chromium_session
from auto24_service.guard import MNT
from auto24_service.mnt_lookup import MASKED_SELECTORS, Limits, LookupFailed, lookup_background_check
from auto24_service.pdf_check import pdf_matches
from tests.fakesite import Scenario
from tests.fakesite.mnt import SAVE_FIELD, V3_TOKEN, MntScenario, install_fake_mnt

STUB = Path('/app/tests/fixtures/stub-extension')
SEARCH_URL = 'https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf'
REG = '123ABC'
VIN = 'WVWZZZ1KZAW000001'
REG_FIELD = 'soidukOtsingForm:regMark'
VIN_FIELD = 'soidukOtsingForm:vinKood'
FAST = Limits(attempt_s=45, cloudflare_s=3, recaptcha_s=3, answer_s=6, download_s=6, stall_s=8, rounds=3)


def lookup(*scenarios, kind='reg_number', value=REG, limits=FAST, deadline_s=150, **options):
    """Run the driver; each new session gets the next scenario, the last one repeats."""
    logs = []

    def opener(**session_options):
        scenario = scenarios[min(len(logs), len(scenarios) - 1)]
        return open_chromium_session(site=MNT, setup=lambda c: logs.append(install_fake_mnt(c, scenario)),
                                     extension_dir=STUB, **session_options)

    try:
        outcome = lookup_background_check(kind, value, time.monotonic() + deadline_s,
                                          opener=opener, limits=limits, **options)
    except LookupFailed as failed:
        outcome = failed
    return outcome, logs


def failed(outcome, reason, searched_by='reg_number'):
    assert isinstance(outcome, LookupFailed), outcome
    assert (outcome.reason, outcome.searched_by) == (reason, searched_by)
    return True


def test_mnt_session_guards_requests_with_the_mnt_allowlist():
    page_html = '''<html><body><p id="ok">form</p><script>
      for (const url of ["https://www.auto24.ee/soidukid/1", "https://www.googletagmanager.com/gtm.js?id=GTM-FAKE",
                         "https://eteenindus.mnt.ee/resources/app.js"]) fetch(url, {mode: "no-cors"}).catch(() => {});
    </script></body></html>'''
    served = []

    def setup(context):
        def handler(route):
            served.append(route.request.url)
            route.fulfill(status=200, body=page_html if route.request.url == SEARCH_URL else '', content_type='text/html')
        context.route('https://eteenindus.mnt.ee/**', handler)

    with open_chromium_session(site=MNT, setup=setup, extension_dir=STUB) as session:
        assert session.page.url == 'about:blank'
        session.page.goto(SEARCH_URL, wait_until='load')
        session.page.wait_for_timeout(500)
        assert session.page.locator('#ok').inner_text() == 'form'
        try:
            session.page.goto('https://www.auto24.ee/soidukid/1', timeout=5000)
        except Exception:
            pass
        assert session.main_frame_blocked
        assert 'www.auto24.ee/soidukid/' in session.blocked
        assert 'www.googletagmanager.com/gtm.js/' in session.blocked
        assert 'https://eteenindus.mnt.ee/resources/app.js' in served


def test_mnt_session_is_killed_shortly_after_its_deadline():
    from patchright.sync_api import Error as PlaywrightError
    from auto24_service.browser_chromium import SESSION_KILL_GRACE_S
    started = time.monotonic()
    entered = []
    with pytest.raises(PlaywrightError, match='closed'):
        with open_chromium_session(site=MNT, extension_dir=STUB, deadline=started + 3) as session:
            entered.append(time.monotonic())
            session.page.evaluate('new Promise(() => {})')  # a Playwright call with no timeout
    assert entered
    assert 3 + SESSION_KILL_GRACE_S - 1 <= time.monotonic() - started < 3 + SESSION_KILL_GRACE_S + 10


def test_fetches_the_pdf_by_reg_number():
    outcome, logs = lookup(MntScenario())
    assert (outcome.status, outcome.searched_by, outcome.reason) == ('fetched', 'reg_number', None)
    assert pdf_matches(outcome.pdf, REG)
    [search] = logs[0].searches
    assert (search[REG_FIELD], search[VIN_FIELD]) == (REG, '')
    assert search['soidukOtsingForm:recaptchaResponse'] == V3_TOKEN
    assert logs[0].save_fields == [SAVE_FIELD]


def test_searches_by_vin_with_the_reg_number_field_empty():
    outcome, logs = lookup(MntScenario(), kind='vin', value=VIN)
    assert (outcome.status, outcome.searched_by) == ('fetched', 'vin')
    [search] = logs[0].searches
    assert (search[REG_FIELD], search[VIN_FIELD]) == ('', VIN)


def test_register_refusal_is_not_found():
    outcome, logs = lookup(MntScenario(search='not_found'))
    assert (outcome.status, outcome.searched_by, outcome.pdf) == ('not_found', 'reg_number', None)
    assert len(logs) == 1


def test_the_help_text_sentence_alone_is_not_a_refusal():
    outcome, _ = lookup(MntScenario(search='silent'))
    assert failed(outcome, 'site_changed')


def test_cloudflare_page_that_clears_by_itself_is_waited_out():
    outcome, logs = lookup(MntScenario(cloudflare='clears'))
    assert outcome.status == 'fetched'
    assert logs[0].search_pages == 2


def test_cloudflare_page_that_needs_turnstile_clears():
    outcome, logs = lookup(MntScenario(cloudflare='turnstile'))
    assert outcome.status == 'fetched'
    assert (logs[0].turnstile_loads, logs[0].search_pages) == (1, 2)


def test_cloudflare_page_that_never_clears_is_blocked():
    outcome, logs = lookup(MntScenario(cloudflare='stuck'))
    assert failed(outcome, 'blocked', searched_by=None)
    assert logs[0].searches == []


def test_cloudflare_page_at_the_result_url_is_blocked():
    outcome, logs = lookup(MntScenario(result_cloudflare=True))
    assert failed(outcome, 'blocked')
    assert logs[0].save_fields == []


def test_try_again_later_is_blocked():
    outcome, _ = lookup(MntScenario(search='try_again_later'))
    assert failed(outcome, 'blocked')


def test_otsin_waits_for_recaptcha_to_load():
    # Pressed before grecaptcha exists, the live page sends only its tokenless post.
    outcome, logs = lookup(MntScenario(v3_delay_ms=1500))
    assert outcome.status == 'fetched'
    [search] = logs[0].searches
    assert search['soidukOtsingForm:recaptchaResponse'] == V3_TOKEN


def test_recaptcha_that_never_loads_is_captcha_failed():
    outcome, logs = lookup(MntScenario(v3_delay_ms=-1))
    assert failed(outcome, 'captcha_failed', searched_by=None)
    assert len(logs) == 2
    assert [(log.searches, log.tokenless_searches) for log in logs] == [([], 0), ([], 0)]


def test_rejected_token_is_captcha_failed():
    outcome, logs = lookup(MntScenario(token='rejected'))
    assert failed(outcome, 'captcha_failed')
    assert len(logs) == 2
    assert logs[0].save_fields == []


def test_rejected_token_fails_without_waiting_out_the_answer_limit():
    start = time.monotonic()
    outcome, logs = lookup(MntScenario(token='rejected'), limits=Limits(attempt_s=90, recaptcha_s=3, answer_s=30))
    assert failed(outcome, 'captcha_failed')
    assert len(logs) == 2
    assert time.monotonic() - start < 20


def test_page_without_its_scripts_fails_at_once_and_retries():
    start = time.monotonic()
    outcome, logs = lookup(MntScenario(scripts=False, plain_stalls=True), limits=replace(FAST, answer_s=30))
    assert failed(outcome, 'blocked')
    assert [log.plain_searches for log in logs] == [1, 1]
    assert time.monotonic() - start < 20


def test_outage_page_gets_a_fresh_session(caplog):
    caplog.set_level('INFO')
    outcome, logs = lookup(MntScenario(outage=True), MntScenario())
    assert outcome.status == 'fetched'
    assert 'background_check_event=try_again_later' in caplog.text


def test_outage_that_lasts_is_blocked_without_a_search():
    start = time.monotonic()
    outcome, logs = lookup(MntScenario(outage=True))
    assert failed(outcome, 'blocked', searched_by=None)
    assert [log.search_pages for log in logs] == [1, 1]
    assert time.monotonic() - start < 20


def test_salvestan_that_shows_late_is_waited_for():
    outcome, logs = lookup(MntScenario(save_link_delay_ms=8000))
    assert outcome.status == 'fetched'


def test_slow_pdf_fits_the_default_download_limit():
    defaults = Limits()
    outcome, logs = lookup(MntScenario(pdf_delay_ms=35_000),
                           limits=replace(FAST, attempt_s=defaults.attempt_s, download_s=defaults.download_s))
    assert outcome.status == 'fetched'


def test_missing_search_form_is_site_changed():
    outcome, logs = lookup(MntScenario(form=False))
    assert failed(outcome, 'site_changed', searched_by=None)
    assert logs[0].searches == []


def test_missing_salvestan_is_site_changed():
    outcome, logs = lookup(MntScenario(save_link=False))
    assert failed(outcome, 'site_changed')
    assert logs[0].save_fields == []


def test_solved_challenge_gets_a_second_otsin():
    outcome, logs = lookup(MntScenario(search='challenge'))
    assert outcome.status == 'fetched'
    assert len(logs) == 1
    # The second press posts with the first token, then with a fresh one.
    assert len(logs[0].searches) == 3


def test_challenge_parked_offscreen_after_a_pass_counts_as_closed():
    # No checkbox tick after the pass, so only the parked frame tells the driver it closed.
    parked = Scenario(captcha='challenge', pass_hides_bframe='offscreen', pass_ticks_anchor=False)
    outcome, logs = lookup(MntScenario(search='challenge', challenge=parked))
    assert outcome.status == 'fetched'
    assert len(logs) == 1
    assert len(logs[0].searches) == 3


def test_failed_challenge_retries_once_in_a_fresh_session():
    failing = MntScenario(search='challenge', challenge=Scenario(captcha='challenge', incorrect_rounds=9))
    outcome, logs = lookup(failing, MntScenario())
    assert outcome.status == 'fetched'
    assert len(logs) == 2

    outcome, logs = lookup(failing)
    assert failed(outcome, 'captcha_failed')
    assert len(logs) == 2


def test_unknown_visible_challenge_is_captcha_failed():
    outcome, logs = lookup(MntScenario(search='unknown_challenge'))
    assert failed(outcome, 'captcha_failed')
    assert len(logs) == 2


@pytest.mark.parametrize('download', ['not_pdf', 'oversized', 'other_car', 'none'])
def test_wrong_downloads_are_pdf_rejected(download):
    outcome, logs = lookup(MntScenario(download=download))
    assert failed(outcome, 'pdf_rejected')
    assert len(logs) == 1


def test_the_deadline_ends_the_lookup_as_timeout():
    slow = Limits(attempt_s=45, cloudflare_s=3, answer_s=60, download_s=6, stall_s=8, rounds=3)
    started = time.monotonic()
    outcome, _ = lookup(MntScenario(search='silent'), limits=slow, deadline_s=12)
    assert failed(outcome, 'timeout')
    assert time.monotonic() - started < 25


def test_debug_screenshots_mask_the_reg_number_and_vin(tmp_path):
    from PIL import Image
    boxes = {}

    def spy(event, page):
        boxes[event] = page.locator('h1').bounding_box() if event == 'result' else None

    outcome, _ = lookup(MntScenario(), debug_dir=tmp_path, on_debug=spy)
    assert outcome.status == 'fetched'
    assert '.content-title p' in MASKED_SELECTORS
    box = boxes['result']
    png = sorted(tmp_path.glob('*result.png'))[-1]
    with Image.open(png) as img:
        x0, y0 = int(box['x']) + 1, int(box['y']) + 1
        x1, y1 = int(box['x'] + box['width']) - 1, int(box['y'] + box['height']) - 1
        colours = img.convert('RGB').crop((x0, y0, x1, y1)).getcolors()
    assert colours is not None and len(colours) == 1 and colours[0][1] == (0, 0, 0)


def test_slow_accepted_token_body_does_not_reject_stale_error():
    outcome, logs = lookup(MntScenario(token_body_delay_ms=3000))
    assert outcome.status == 'fetched'
    assert len(logs) == 1
    assert logs[0].tokenless_searches == 1


@pytest.mark.parametrize('scenario', [MntScenario(result_outage=True), MntScenario(search='try_again_later')])
def test_answer_outage_retries_in_fresh_session(scenario):
    outcome, logs = lookup(scenario, MntScenario())
    assert outcome.status == 'fetched'
    assert len(logs) == 2
    assert logs[0].save_fields == []
    assert len(logs[1].searches) == 1
