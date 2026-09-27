"""Capture rendered HTML from one public Auto24 listing."""

from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from camoufox.sync_api import Camoufox

from auto24_service.urls import InvalidListingURL, canonical_listing_url

ALLOWED_SUBRESOURCE_HOSTS = frozenset({"www.auto24.ee"})


class CaptureError(RuntimeError):
    """A stable browser failure that maps to a listing error code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _allowed_url(url: str, *, main_frame: bool) -> bool:
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except (TypeError, ValueError):
        return False
    if (
        parts.scheme != "https"
        or host is None
        or port is not None
        or parts.username is not None
        or parts.password is not None
        or parts.netloc.casefold() != host
    ):
        return False
    if main_frame:
        return host == "www.auto24.ee"
    return host in ALLOWED_SUBRESOURCE_HOSTS


def _page_error(html: str) -> str | None:
    text = " ".join(BeautifulSoup(html, "html.parser").stripped_strings).casefold()
    if any(
        phrase in text
        for phrase in (
            "listing is no longer available",
            "listing no longer available",
            "advertisement has expired",
            "kuulutus on aegunud",
            "kuulutus ei ole enam saadaval",
        )
    ):
        return "listing_gone"
    if any(
        phrase in text
        for phrase in (
            "verify you are human",
            "checking your browser",
            "just a moment",
            "complete the security check",
            "access denied",
            "unusual traffic",
            "captcha",
        )
    ):
        return "access_blocked"
    return None


def capture_html(url: str) -> str:
    """Open a fresh Camoufox session and return a checked rendered document."""
    try:
        canonical_url = canonical_listing_url(url)
    except InvalidListingURL as exc:
        raise CaptureError("access_blocked") from exc

    blocked_main_frame = False
    try:
        with Camoufox(headless=True) as browser:
            page = browser.new_page()

            def guard_request(route) -> None:
                nonlocal blocked_main_frame
                request = route.request
                is_main_frame = (
                    request.is_navigation_request() and request.frame == page.main_frame
                )
                if _allowed_url(request.url, main_frame=is_main_frame):
                    route.continue_()
                else:
                    blocked_main_frame |= is_main_frame
                    route.abort()

            page.route("**/*", guard_request)
            response = page.goto(
                canonical_url, timeout=45_000, wait_until="domcontentloaded"
            )
            if blocked_main_frame:
                raise CaptureError("access_blocked")
            if response is None:
                raise CaptureError("temporary_failure")
            if response.status in (404, 410):
                raise CaptureError("listing_gone")
            if response.status in (401, 403, 429):
                raise CaptureError("access_blocked")
            if response.status >= 400:
                if _page_error(page.content()) == "access_blocked":
                    raise CaptureError("access_blocked")
                raise CaptureError("temporary_failure")
            try:
                if canonical_listing_url(page.url) != canonical_url:
                    raise CaptureError("access_blocked")
            except InvalidListingURL as exc:
                raise CaptureError("access_blocked") from exc
            html = page.content()
            if error := _page_error(html):
                raise CaptureError(error)
            return html
    except CaptureError:
        raise
    except Exception as exc:
        if blocked_main_frame:
            raise CaptureError("access_blocked") from exc
        raise CaptureError("temporary_failure") from exc
