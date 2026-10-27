from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from auto24_service import browser
from auto24_service.captcha.reveal import reveal_registration
from auto24_service.diagnostics import NULL_OBSERVER
from auto24_service.opener import ListingOpener, RetryOpener

URL = "https://www.auto24.ee/soidukid/1234567"


def test_openers_require_the_threading_flag():
    with pytest.raises(TypeError):
        ListingOpener(lambda url, **kw: None)
    with pytest.raises(TypeError):
        RetryOpener(lambda **kw: None)


def test_listing_opener_always_passes_every_parameter():
    seen = []
    opener = ListingOpener(lambda url, **kw: seen.append((url, kw)), same_thread=False)
    opener(URL, deadline=5.0)
    assert seen == [(URL, dict(profile_dir=None, deadline=5.0, keep_profile=None, observer=NULL_OBSERVER))]


def test_capture_listing_rejects_a_bare_function():
    @contextmanager
    def opener(url, **kw):
        yield None

    with pytest.raises(TypeError):
        browser.capture_listing(URL, solver=None, opener=opener)


def test_opener_missing_a_parameter_fails_instead_of_dropping_the_deadline():
    @contextmanager
    def opener(url, *, profile_dir, keep_profile, observer):
        yield None

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_listing(URL, solver=None, opener=ListingOpener(opener, same_thread=False), deadline=10.0)
    assert isinstance(error.value.__cause__, TypeError)


def test_retry_opener_missing_the_deadline_fails():
    with pytest.raises(TypeError):
        RetryOpener(lambda: None, same_thread=False)(deadline=1.0)


def test_reveal_rejects_a_bare_reopen():
    with pytest.raises(TypeError):
        reveal_registration(SimpleNamespace(page=None), lambda **kw: None, None)
