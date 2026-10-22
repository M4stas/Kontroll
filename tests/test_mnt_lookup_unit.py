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
    import auto24_service.captcha.extension_wait as extension_wait
    monkeypatch.setattr(extension_wait, "watch_extension",
                        lambda page, **kw: SimpleNamespace(passed=False, reason="try_again_later"))
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
