from dataclasses import dataclass

import pytest

from auto24_service import browser


LISTING_URL = "https://www.auto24.ee/soidukid/4344096"


@dataclass
class FakeFrame:
    parent_frame: object | None = None


class FakeRequest:
    def __init__(self, url, *, navigation=False, frame=None):
        self.url = url
        self._navigation = navigation
        self.frame = frame

    def is_navigation_request(self):
        return self._navigation


class FakeRoute:
    def __init__(self, request):
        self.request = request
        self.action = None

    def continue_(self):
        self.action = "continue"

    def abort(self):
        self.action = "abort"


class FakeResponse:
    def __init__(self, status):
        self.status = status


class FakePage:
    def __init__(self, *, status=200, html="<main>listing</main>", final_url=None, redirect=None, resources=()):
        self.status = status
        self.html = html
        self.url = final_url or LISTING_URL
        self.redirect = redirect
        self.resources = resources
        self.main_frame = FakeFrame()
        self.route_handler = None
        self.navigation = None

    def route(self, pattern, handler):
        self.route_handler = handler

    def _request(self, url, *, navigation=False, frame=None):
        route = FakeRoute(FakeRequest(url, navigation=navigation, frame=frame))
        self.route_handler(route)
        return route

    def goto(self, url, *, timeout, wait_until):
        self.navigation = (url, timeout, wait_until)
        initial = self._request(url, navigation=True, frame=self.main_frame)
        assert initial.action == "continue"
        for resource in self.resources:
            self._request(resource)
        if self.redirect:
            redirected = self._request(self.redirect, navigation=True, frame=self.main_frame)
            if redirected.action == "abort":
                raise RuntimeError("navigation blocked by route")
        return FakeResponse(self.status)

    def content(self):
        return self.html


class FakeBrowser:
    def __init__(self, page):
        self.page = page

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def new_page(self):
        return self.page


def install_fake_browser(monkeypatch, page):
    monkeypatch.setattr(browser, "Camoufox", lambda *, headless: FakeBrowser(page))


def test_capture_returns_rendered_html_with_bounded_main_frame_navigation(monkeypatch):
    page = FakePage(html="<main>rendered listing</main>")
    install_fake_browser(monkeypatch, page)

    assert browser.capture_html(LISTING_URL) == "<main>rendered listing</main>"
    assert page.navigation == (LISTING_URL, 45_000, "domcontentloaded")


def test_capture_blocks_main_frame_redirect_to_unrelated_host(monkeypatch):
    page = FakePage(redirect="https://example.org/collect")
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == "access_blocked"


@pytest.mark.parametrize("status", [404, 410])
def test_capture_reports_missing_listing_status_as_gone(monkeypatch, status):
    page = FakePage(status=status)
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == "listing_gone"


@pytest.mark.parametrize("status", [401, 403, 429])
def test_capture_reports_authentication_and_rate_limits_as_blocked(monkeypatch, status):
    page = FakePage(status=status)
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == "access_blocked"


def test_capture_reports_rendered_gone_page_as_gone(monkeypatch):
    page = FakePage(html="<main><h1>This listing is no longer available</h1></main>")
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == "listing_gone"


def test_capture_reports_browser_challenge_as_blocked(monkeypatch):
    page = FakePage(html="<main><h1>Verify you are human</h1><p>Complete the security check</p></main>")
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == "access_blocked"


def test_capture_aborts_private_and_unrelated_subresource_requests(monkeypatch):
    page = FakePage(resources=("https://127.0.0.1/admin", "https://tracker.example.org/pixel"))
    install_fake_browser(monkeypatch, page)

    browser.capture_html(LISTING_URL)

    assert page._request("https://127.0.0.1/admin").action == "abort"
    assert page._request("https://tracker.example.org/pixel").action == "abort"
