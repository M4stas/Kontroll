"""MNT driver logic that needs no browser. Fake values only."""

import time
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

import auto24_service.mnt_lookup as mnt
from auto24_service.mnt_lookup import Limits, LookupFailed, lookup_background_check

REG = "123ABC"


def attempt(**limits):
    return mnt._Attempt(None, "reg_number", REG, time.monotonic() + 60, Limits(**limits),
                        debug=lambda *a: None, keep_profile=None)


class FramesPage:
    """Answers the frame scan in one evaluate; per-frame calls would wait 30 s."""

    def __init__(self, frames):
        self.frames = frames

    def evaluate(self, script):
        return self.frames

    def locator(self, selector):
        raise AssertionError("per-frame locator calls can wait Playwright's default 30 s")


def frame(src="", visible=True, width=320, height=320, x=10, y=10):
    return dict(src=src, visible=visible, x=x, y=y, width=width, height=height)


def test_unknown_challenge_reads_all_frames_at_once():
    assert attempt().unknown_challenge(FramesPage([frame("about:blank", visible=False), frame("/public/puzzle.html")]))
    assert not attempt().unknown_challenge(FramesPage([
        frame("https://www.google.com/recaptcha/api2/bframe?k=x"), frame(width=1, height=1), frame(visible=False),
    ]))
    assert not attempt().unknown_challenge(FramesPage(None))


def test_extension_try_again_later_is_blocked(monkeypatch):
    import sys
    # Test the driver's classification without loading the Chromium solver stack.
    monkeypatch.setitem(sys.modules, "auto24_service.captcha.extension_wait", SimpleNamespace(
        watch_extension=lambda page, **kw: SimpleNamespace(passed=False, reason="try_again_later")))
    run = attempt()
    run.sent = True
    with pytest.raises(LookupFailed) as failed:
        run.watch_challenge(SimpleNamespace(url="about:blank", locator=lambda *a, **kw: None))
    assert (failed.value.reason, failed.value.searched_by) == ("blocked", "reg_number")


def test_retry_keeps_searched_by_from_the_first_attempt(monkeypatch):
    endings = iter([LookupFailed("captcha_failed", "reg_number"), LookupFailed("blocked", None)])

    def run(self):
        raise next(endings)

    monkeypatch.setattr(mnt._Attempt, "run", run)
    with pytest.raises(LookupFailed) as failed:
        lookup_background_check("reg_number", REG, time.monotonic() + 60, opener=object())
    assert (failed.value.reason, failed.value.searched_by) == ("blocked", "reg_number")


def test_playwright_error_at_the_attempt_end_is_not_a_crash():
    @contextmanager
    def opener(**options):
        yield SimpleNamespace(page=None)

    def stuck(session):
        time.sleep(0.3)
        raise TimeoutError("Timeout 1ms exceeded")

    run = mnt._Attempt(opener, "reg_number", REG, time.monotonic() + 60, Limits(attempt_s=0.2),
                       debug=lambda *a: None, keep_profile=None)
    run.drive = stuck
    with pytest.raises(LookupFailed) as failed:
        run.run()
    assert failed.value.reason == "site_changed"


def test_mnt_lookup_imports_without_browser_dependencies():
    import subprocess
    import sys
    code = '''
import importlib.abc, sys
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'camoufox', 'patchright', 'bs4', 'PIL', 'playwright'}:
            raise ImportError(fullname)
sys.meta_path.insert(0, Block())
from auto24_service.mnt_lookup import _Attempt
from auto24_service.session import CaptureError
from contextlib import contextmanager
import time
@contextmanager
def opener(**kwargs):
    raise CaptureError('access_blocked')
    yield
try:
    _Attempt(opener, 'reg_number', '123ABC', time.monotonic()+10, __import__('auto24_service.mnt_lookup', fromlist=['Limits']).Limits(), debug=lambda *a: None, keep_profile=None).run()
except Exception as e:
    assert e.reason == 'blocked', repr(e)
else:
    sys.exit(1)
'''
    assert subprocess.run([sys.executable, '-c', code], check=False).returncode == 0


def test_invisible_session_waits_for_badge(monkeypatch):
    from auto24_service import browser_invisible
    checks = iter([False, False, True])
    monkeypatch.setattr(browser_invisible, 'recaptcha_badge_shown', lambda page: next(checks))
    page = SimpleNamespace(wait_for_timeout=lambda ms: None)
    attempt().wait_for_recaptcha(SimpleNamespace(page=page, engine='invisible'))
    assert next(checks, 'done') == 'done'


def test_invisible_download_uses_response(monkeypatch):
    from auto24_service import browser_invisible
    @contextmanager
    def response(page, timeout_ms):
        yield SimpleNamespace(body=b'%PDF-1.4 fake')
    monkeypatch.setattr(browser_invisible, 'expect_pdf_response', response)
    button = SimpleNamespace(wait_for=lambda **kw: None, click=lambda **kw: None)
    page = SimpleNamespace(locator=lambda *a, **kw: SimpleNamespace(first=button))
    assert attempt().download(SimpleNamespace(page=page, engine='invisible')) == b'%PDF-1.4 fake'


def test_invisible_download_missing_pdf_is_rejected(monkeypatch):
    from auto24_service import browser_invisible

    @contextmanager
    def response(page, timeout_ms):
        yield SimpleNamespace(body=None)

    monkeypatch.setattr(browser_invisible, 'expect_pdf_response', response)
    button = SimpleNamespace(wait_for=lambda **kw: None, click=lambda **kw: None)
    page = SimpleNamespace(locator=lambda *a, **kw: SimpleNamespace(first=button))
    events = []
    run = attempt()
    run.debug = lambda event, page: events.append(event)
    with pytest.raises(LookupFailed) as failed:
        run.download(SimpleNamespace(page=page, engine='invisible'))
    assert failed.value.reason == 'pdf_rejected'
    assert events == ['no_download']


@pytest.mark.parametrize('deadline_expired,reason', [(False, 'site_changed'), (True, 'timeout')])
def test_invisible_missing_pdf_at_attempt_end_uses_timeout_classification(monkeypatch, deadline_expired, reason):
    from auto24_service import browser_invisible
    run = attempt()
    @contextmanager
    def response(page, timeout_ms):
        yield SimpleNamespace(body=None)
        run.end = time.monotonic()
        if deadline_expired:
            run.deadline = run.end
    monkeypatch.setattr(browser_invisible, 'expect_pdf_response', response)
    button = SimpleNamespace(wait_for=lambda **kw: None, click=lambda **kw: None)
    page = SimpleNamespace(locator=lambda *a, **kw: SimpleNamespace(first=button))
    with pytest.raises(LookupFailed) as failed:
        run.download(SimpleNamespace(page=page, engine='invisible'))
    assert failed.value.reason == reason


@pytest.mark.browser
def test_badge_helper_checks_dom():
    import os

    sync_playwright = pytest.importorskip('patchright.sync_api').sync_playwright
    from auto24_service.browser_invisible import recaptcha_badge_shown
    with sync_playwright() as driver:
        browser = driver.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),
            headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.set_content('<div class="unrelated-badge"></div>')
            assert recaptcha_badge_shown(page) is False
            page.evaluate("document.body.insertAdjacentHTML('beforeend', '<div class=grecaptcha-badge></div>')")
            assert recaptcha_badge_shown(page) is True
            page.locator('.grecaptcha-badge').evaluate('(element) => element.remove()')
            assert recaptcha_badge_shown(page) is False
        finally:
            browser.close()


def test_pdf_response_collects_first_pdf_and_removes_listener():
    from auto24_service.browser_invisible import expect_pdf_response
    class Page:
        def on(self, event, callback):
            self.callback = callback
        def remove_listener(self, event, callback):
            assert callback == self.callback
            self.removed = True
        def wait_for_timeout(self, ms):
            self.callback(SimpleNamespace(headers={'content-type': 'text/html'}, body=lambda: b'html'))
            self.callback(SimpleNamespace(headers={'content-type': 'application/pdf'}, body=lambda: b'%PDF-first'))
            self.callback(SimpleNamespace(headers={'content-type': 'application/pdf'}, body=lambda: b'%PDF-second'))
    page = Page()
    with expect_pdf_response(page, 100) as result:
        assert result.body is None
    assert result.body == b'%PDF-first' and page.removed


@pytest.mark.parametrize('headers,expected', [
    ({'content-type': 'text/html'}, None),
    ({'content-disposition': 'attachment; filename=report'}, b'%PDF-test'),
    ({'content-type': 'application/PDF'}, b'%PDF-test'),
])
def test_pdf_response_reads_only_candidate_bodies(headers, expected):
    from auto24_service.browser_invisible import expect_pdf_response
    reads = []
    class Page:
        def on(self, event, callback): self.callback = callback
        def remove_listener(self, event, callback): pass
        def wait_for_timeout(self, ms):
            def body():
                reads.append(True)
                return b'%PDF-test'
            self.callback(SimpleNamespace(headers=headers, body=body))
    with expect_pdf_response(Page(), 10) as result:
        pass
    assert result.body == expected
    assert len(reads) == (0 if expected is None else 1)


def test_pdf_response_missing_removes_listener():
    from auto24_service.browser_invisible import expect_pdf_response
    class Page:
        def on(self, event, callback): self.callback = callback
        def remove_listener(self, event, callback): self.removed = True
        def wait_for_timeout(self, ms): pass
    page = Page()
    with expect_pdf_response(page, 0) as result:
        pass
    assert result.body is None and page.removed


def test_pdf_response_block_consumes_timeout_budget(monkeypatch):
    from auto24_service import browser_invisible

    now = [0.0]
    monkeypatch.setattr(browser_invisible.time, 'monotonic', lambda: now[0])

    class Page:
        def on(self, event, callback): self.callback = callback
        def remove_listener(self, event, callback): self.removed = True
        def wait_for_timeout(self, ms): now[0] += ms / 1000

    page = Page()
    with browser_invisible.expect_pdf_response(page, 100) as result:
        now[0] += 0.2
    assert result.body is None and page.removed
    assert now[0] == 0.2
