"""Capture rendered HTML from one public Auto24 listing."""

import time
import sys
from auto24_service.diagnostics import PhaseObserver, NULL_OBSERVER
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from camoufox.sync_api import Camoufox

from auto24_service.urls import InvalidListingURL, canonical_listing_url

ALLOWED_SUBRESOURCE_HOSTS = frozenset({"www.auto24.ee"})
_REDIRECT_STATUS_CODES = frozenset({300, 301, 302, 303, 307, 308})
_MAX_MAIN_FRAME_REDIRECTS = 5
_MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS = 45


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
            "kuulutus ei ole aktiivne",
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


def capture_html(url: str, observer: PhaseObserver = NULL_OBSERVER) -> str:
    """Open a fresh Camoufox session and return a checked rendered document."""
    try:
        canonical_url = canonical_listing_url(url)
    except InvalidListingURL as exc:
        raise CaptureError("access_blocked") from exc

    blocked_main_frame = False
    try:
        manager = Camoufox(
            headless=True,
            firefox_user_prefs={"network.http.redirection-limit": 0},
        )
        with observer.phase("browser_start"):
            browser = manager.__enter__()
        try:
            with observer.phase("page_setup"):
                context = browser.new_context(service_workers="block")
                page = context.new_page()
                pending_main_frame_redirect: str | None = None

                def inspect_main_frame_response(response) -> None:
                    nonlocal blocked_main_frame, pending_main_frame_redirect
                    request = response.request
                    if (
                        not request.is_navigation_request()
                        or request.frame != page.main_frame
                        or response.status not in _REDIRECT_STATUS_CODES
                    ):
                        return
                    location = response.headers.get("location")
                    target_url = urljoin(response.url, location) if location else ""
                    if _allowed_url(target_url, main_frame=True):
                        pending_main_frame_redirect = target_url
                    else:
                        blocked_main_frame = True

                page.on("response", inspect_main_frame_response)

                def guard_request(route) -> None:
                    nonlocal blocked_main_frame
                    request = route.request
                    is_main_frame = (
                        request.is_navigation_request() and request.frame == page.main_frame
                    )
                    if not _allowed_url(request.url, main_frame=is_main_frame):
                        blocked_main_frame |= is_main_frame
                        route.abort()
                        return

                    route.continue_()

                context.route("**/*", guard_request)
            with observer.phase("navigation"):
                current_url = canonical_url
                response = None
                navigation_deadline = time.monotonic() + _MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS
                for _ in range(_MAX_MAIN_FRAME_REDIRECTS + 1):
                    remaining_timeout_ms = int(
                        (navigation_deadline - time.monotonic()) * 1000
                    )
                    if remaining_timeout_ms <= 0:
                        raise CaptureError("temporary_failure")
                    pending_main_frame_redirect = None
                    try:
                        response = page.goto(
                            current_url,
                            timeout=remaining_timeout_ms,
                            wait_until="domcontentloaded",
                        )
                    except Exception as exc:
                        if blocked_main_frame:
                            raise CaptureError("access_blocked") from exc
                        if pending_main_frame_redirect is not None:
                            current_url = pending_main_frame_redirect
                            continue
                        raise CaptureError("temporary_failure") from exc
                    if blocked_main_frame:
                        raise CaptureError("access_blocked")
                    if pending_main_frame_redirect is not None:
                        current_url = pending_main_frame_redirect
                        continue
                    if response is not None and response.status in _REDIRECT_STATUS_CODES:
                        location = response.headers.get("location")
                        target_url = urljoin(current_url, location) if location else ""
                        if not _allowed_url(target_url, main_frame=True):
                            raise CaptureError("access_blocked")
                        current_url = target_url
                        continue
                    break
                else:
                    raise CaptureError("access_blocked")

            with observer.phase("validation"):
                if response is None:
                    raise CaptureError("temporary_failure")
                if response.status in (404, 410):
                    raise CaptureError("listing_gone")
                if response.status in (401, 403, 429):
                    raise CaptureError("access_blocked")
                if response.status >= 400:
                    with observer.phase("html_retrieval"):
                        error_html = page.content()
                    if _page_error(error_html) == "access_blocked":
                        raise CaptureError("access_blocked")
                    raise CaptureError("temporary_failure")
                try:
                    if canonical_listing_url(page.url) != canonical_url:
                        raise CaptureError("access_blocked")
                except InvalidListingURL as exc:
                    raise CaptureError("access_blocked") from exc
            with observer.phase("html_retrieval"):
                html = page.content()
            with observer.phase("validation"):
                if blocked_main_frame:
                    raise CaptureError("access_blocked")
                if error := _page_error(html):
                    raise CaptureError(error)
            return html
        finally:
            with observer.phase("browser_shutdown"):
                manager.__exit__(*sys.exc_info())
    except CaptureError:
        raise
    except Exception as exc:
        if blocked_main_frame:
            raise CaptureError("access_blocked") from exc
        raise CaptureError("temporary_failure") from exc
