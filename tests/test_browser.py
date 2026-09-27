from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit

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
    def __init__(self, request, response):
        self.request = request
        self.response = response
        self.action = None

    def continue_(self):
        self.action = "continue"

    def abort(self):
        self.action = "abort"


class FakeResponse:
    def __init__(self, status, headers=None):
        self.status = status
        self.headers = headers or {}


class FakePage:
    def __init__(
        self,
        *,
        status=200,
        html="<main>listing</main>",
        final_url=None,
        redirect=None,
        redirects=None,
        resources=(),
    ):
        self.status = status
        self.html = html
        self.url = final_url or LISTING_URL
        self.redirect = redirect
        self.redirects = redirects or {}
        self.resources = resources
        self.main_frame = FakeFrame()
        self.route_handler = None
        self.navigation = None
        self.visited_urls = []
        self.routes = []

    def route(self, pattern, handler):
        self.route_handler = handler

    def on(self, event, handler):
        assert event == "response"

    def _request(self, url, *, navigation=False, frame=None):
        redirect = (
            self.redirect
            if navigation and url == LISTING_URL
            else self.redirects.get(url)
        )
        response = (
            FakeResponse(302, {"location": redirect})
            if redirect
            else FakeResponse(self.status if navigation else 200)
        )
        route = FakeRoute(
            FakeRequest(url, navigation=navigation, frame=frame), response
        )
        self.route_handler(route)
        self.routes.append(route)
        return route

    def goto(self, url, *, timeout, wait_until):
        self.navigation = (url, timeout, wait_until)
        self.visited_urls.append(url)
        self.url = url
        initial = self._request(url, navigation=True, frame=self.main_frame)
        if initial.action == "abort":
            raise RuntimeError("navigation blocked by route")
        assert initial.action == "continue"
        for resource in self.resources:
            self._request(resource)
        return initial.response

    def content(self):
        return self.html


class FakeBrowser:
    def __init__(self, page):
        self.page = page

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def new_context(self, *, service_workers):
        assert service_workers == "block"
        return FakeContext(self.page)


class FakeContext:
    def __init__(self, page):
        self.page = page

    def route(self, pattern, handler):
        self.page.route(pattern, handler)

    def new_page(self):
        return self.page


def install_fake_browser(monkeypatch, page):
    def camoufox(*, headless, firefox_user_prefs):
        assert headless is True
        assert firefox_user_prefs == {"network.http.redirection-limit": 0}
        return FakeBrowser(page)

    monkeypatch.setattr(browser, "Camoufox", camoufox)


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
    assert page.visited_urls == [LISTING_URL]


def test_capture_manually_follows_an_allowed_main_frame_redirect(monkeypatch):
    redirected_url = LISTING_URL + "/"
    page = FakePage(redirect=redirected_url, final_url=redirected_url)
    install_fake_browser(monkeypatch, page)

    assert browser.capture_html(LISTING_URL) == "<main>listing</main>"

    assert page.visited_urls == [LISTING_URL, redirected_url]


def test_capture_aborts_a_redirecting_subresource_before_following_it(monkeypatch):
    resource = "https://www.auto24.ee/site.css"
    target = "https://example.org/collect"
    page = FakePage(redirects={resource: target}, resources=(resource,))
    install_fake_browser(monkeypatch, page)

    browser.capture_html(LISTING_URL)

    assert target not in page.visited_urls
    assert page.routes[-1].action == "continue"


def test_real_browser_does_not_contact_a_disallowed_local_redirect_target(monkeypatch):
    target_hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/start":
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{self.server.server_port}/target")
                self.end_headers()
                return
            if self.path == "/target":
                target_hits.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<h1>Unexpected target</h1>")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source_url = f"http://127.0.0.1:{server.server_port}/start"

    monkeypatch.setattr(browser, "canonical_listing_url", lambda _url: source_url)
    monkeypatch.setattr(
        browser,
        "_allowed_url",
        lambda url, *, main_frame: (
            urlsplit(url).scheme == "http"
            and urlsplit(url).hostname == "127.0.0.1"
            and urlsplit(url).port == server.server_port
        ),
    )

    try:
        with pytest.raises(browser.CaptureError) as error:
            browser.capture_html("unused")
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

    assert error.value.code == "access_blocked", repr(error.value.__cause__)
    assert target_hits == []


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


def test_capture_reports_a_known_inactive_listing_page_as_gone(monkeypatch):
    page = FakePage(status=200, html="<h1>Kuulutus ei ole aktiivne!</h1>")
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


def test_capture_aborts_unlisted_auto24_subdomain_requests(monkeypatch):
    page = FakePage(resources=("https://assets.auto24.ee/site.css",))
    install_fake_browser(monkeypatch, page)

    browser.capture_html(LISTING_URL)

    assert page._request("https://assets.auto24.ee/site.css").action == "abort"


@pytest.mark.parametrize(
    ("html", "expected_code"),
    [
        ("<html><title>Just a moment</title></html>", "access_blocked"),
        ("<html><title>Service unavailable</title></html>", "temporary_failure"),
    ],
)
def test_capture_checks_http_503_body_for_challenge_before_generic_failure(
    monkeypatch, html, expected_code
):
    page = FakePage(status=503, html=html)
    install_fake_browser(monkeypatch, page)

    with pytest.raises(browser.CaptureError) as error:
        browser.capture_html(LISTING_URL)

    assert error.value.code == expected_code
