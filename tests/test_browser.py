from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from camoufox import DefaultAddons

from auto24_service import browser
from fakesite import LISTING_URL as FAKE_LISTING_URL, Scenario, install_fake_site


LISTING_URL = "https://www.auto24.ee/soidukid/4344096"


@dataclass(eq=False)
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

    def fallback(self):
        self.action = "fallback"

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
        self.navigation_timeouts = []
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
        self.navigation_timeouts.append(timeout)
        self.visited_urls.append(url)
        self.url = url
        initial = self._request(url, navigation=True, frame=self.main_frame)
        if initial.action == "abort":
            raise RuntimeError("navigation blocked by route")
        assert initial.action == "fallback"
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
    def camoufox(*, headless, humanize, firefox_user_prefs, exclude_addons, block_webrtc):
        assert block_webrtc is True
        assert "browser.startup.page" not in firefox_user_prefs
        assert headless is True
        assert humanize is True
        assert firefox_user_prefs["network.http.redirection-limit"] == 0
        assert firefox_user_prefs["network.dns.disablePrefetch"] is True
        assert firefox_user_prefs["network.http.speculative-parallel-limit"] == 0
        assert exclude_addons == [DefaultAddons.UBO]
        return FakeBrowser(page)

    monkeypatch.setattr(browser, "Camoufox", camoufox)


def test_capture_returns_rendered_html_with_bounded_main_frame_navigation(monkeypatch):
    page = FakePage(html="<main>rendered listing</main>")
    install_fake_browser(monkeypatch, page)

    assert browser.capture_html(LISTING_URL) == "<main>rendered listing</main>"
    assert page.navigation[0] == LISTING_URL
    assert 0 < page.navigation[1] <= 45_000
    assert page.navigation[2] == "domcontentloaded"


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


def test_capture_shares_one_navigation_timeout_across_redirect_hops(monkeypatch):
    first_redirect = LISTING_URL + "/"
    second_redirect = LISTING_URL + "?source=redirect"
    page = FakePage(
        redirect=first_redirect,
        redirects={first_redirect: second_redirect},
        final_url=second_redirect,
    )
    install_fake_browser(monkeypatch, page)
    clock_values = iter((0.0, 0.0, 15.0, 30.0))
    monkeypatch.setattr(
        browser,
        "time",
        SimpleNamespace(monotonic=lambda: next(clock_values)),
        raising=False,
    )

    assert browser.capture_html(LISTING_URL) == "<main>listing</main>"

    assert page.navigation_timeouts == [45_000, 30_000, 15_000]


def test_capture_aborts_a_redirecting_subresource_before_following_it(monkeypatch):
    resource = "https://www.auto24.ee/site.css"
    target = "https://example.org/collect"
    page = FakePage(redirects={resource: target}, resources=(resource,))
    install_fake_browser(monkeypatch, page)

    browser.capture_html(LISTING_URL)

    assert target not in page.visited_urls
    assert page.routes[-1].action == "fallback"


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


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://www.google.com/recaptcha/api2/anchor", True),
        ("https://www.gstatic.com/recaptcha/releases/x/recaptcha__et.js", True),
        ("https://www.google.com/js/bg/x.js", False),
        ("https://www.gstatic.com/other/x.js", False),
        ("https://google.com/recaptcha/x", False),
        ("http://www.google.com/recaptcha/x", False),
        ("https://www.google.com:443/recaptcha/x", False),
        ("https://www.google.com/recaptchax/x", False),
        ("https://www.google.com/recaptcha/..%2fjs/x.js", False),
        ("https://www.google.com/recaptcha/..%2Fjs/x.js", False),
        ("https://www.google.com/recaptcha/%2e%2e/js/x.js", False),
        ("https://www.google.com/recaptcha/../js/x.js", False),
        ("https://www.gstatic.com/recaptcha/..%5cother/x.js", False),
        ("https://www.google.com/recaptcha/api2/x%2Fy", False),
        ("https://www.google.com/recaptcha/%252e%252e/js/x.js", False),
        ("https://www.google.com/recaptcha/api2/%252fjs", False),
        ("https://www.gstatic.com/recaptcha/%25%32%65/x.js", False),
        ("https://www.google.com/recaptcha/api2/a%20b", False),
    ],
)
def test_guard_allows_only_recaptcha_paths_on_google_hosts(url, allowed):
    assert browser._allowed_url(url, main_frame=False) is allowed
    assert browser._allowed_url(url, main_frame=True) is False


def test_allowed_request_falls_back_instead_of_continuing(monkeypatch):
    resource = "https://www.google.com/recaptcha/api.js"
    page = FakePage(resources=(resource,))
    install_fake_browser(monkeypatch, page)

    browser.capture_html(LISTING_URL)

    assert [route.action for route in page.routes] == ["fallback", "fallback"]


def test_blocked_google_path_is_recorded_and_attempt_fails_cleanly():
    pytest.importorskip("camoufox.sync_api")
    blocked_url = "https://www.google.com/js/bg/x.js"
    logs = []

    def setup(context):
        logs.append(install_fake_site(context, Scenario(extra_request=blocked_url)))

    with browser.open_listing(FAKE_LISTING_URL, setup=setup) as session:
        session.page.click('.service-trigger[data-action="uv_regnr"]')
        # api.js loads after the click and then fires the extra request; poll for it.
        for _ in range(50):
            if "www.google.com/js/" in session.blocked:
                break
            session.page.wait_for_timeout(200)
        session.page.wait_for_timeout(500)
        assert session.blocked.count("www.google.com/js/") == 1
        assert len(session.blocked) == len(set(session.blocked))

    assert blocked_url not in logs[0].requests


def test_open_listing_with_profile_dir_reuses_cookies(tmp_path):
    pytest.importorskip("camoufox.sync_api")

    def setup(context):
        install_fake_site(context, Scenario())

    with browser.open_listing(FAKE_LISTING_URL, setup=setup, profile_dir=tmp_path) as session:
        session.page.evaluate("document.cookie = 'kept=yes; max-age=86400; path=/'")
    with browser.open_listing(FAKE_LISTING_URL, setup=setup, profile_dir=tmp_path) as session:
        cookies = session.context.cookies("https://www.auto24.ee/")
    assert [c["value"] for c in cookies if c["name"] == "kept"] == ["yes"]


def test_blocked_entry_drops_the_query_string():
    assert browser._blocked_entry("https://www.google.com/js/x?token=secret") == "www.google.com/js/"


def test_top_level_navigation_in_a_popup_is_guarded_as_main_frame(monkeypatch):
    page = FakePage()
    install_fake_browser(monkeypatch, page)
    browser.capture_html(LISTING_URL)

    recaptcha = "https://www.google.com/recaptcha/api2/anchor"
    popup = page._request(recaptcha, navigation=True, frame=FakeFrame(parent_frame=None))
    subframe = page._request(
        recaptcha, navigation=True, frame=FakeFrame(parent_frame=page.main_frame)
    )

    assert popup.action == "abort"
    assert subframe.action == "fallback"


def test_persistent_profile_launch_blocks_restore_and_webrtc(monkeypatch, tmp_path):
    page = FakePage()
    seen = {}

    class PersistentContext(FakeContext):
        pages = [page]

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

    def camoufox(**kwargs):
        seen.update(kwargs)
        return PersistentContext(page)

    monkeypatch.setattr(browser, "Camoufox", camoufox)
    with browser.open_listing(LISTING_URL, profile_dir=tmp_path / "profile"):
        pass

    prefs = seen["firefox_user_prefs"]
    assert prefs["browser.startup.page"] == 0
    assert prefs["browser.sessionstore.resume_from_crash"] is False
    assert prefs["network.http.redirection-limit"] == 0
    assert seen["block_webrtc"] is True
    assert seen["persistent_context"] is True
    assert seen["user_data_dir"] == str(tmp_path / "profile")
