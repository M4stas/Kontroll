"""Capture rendered HTML from one public Auto24 listing."""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from camoufox.sync_api import Camoufox
from playwright.sync_api import BrowserContext, Page

from auto24_service.urls import InvalidListingURL, canonical_listing_url

ALLOWED_SUBRESOURCE_HOSTS = frozenset({"www.auto24.ee"})
ALLOWED_SUBRESOURCE_PREFIXES = (
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
)
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
    if host in ALLOWED_SUBRESOURCE_HOSTS:
        return True
    return url.startswith(ALLOWED_SUBRESOURCE_PREFIXES)


def _blocked_entry(url: str) -> str:
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
    except (TypeError, ValueError):
        return "invalid/"
    segment = parts.path.lstrip("/").split("/", 1)[0]
    return f"{host}/{segment}/" if segment else f"{host}/"


@dataclass
class ListingSession:
    page: Page
    context: BrowserContext
    blocked: list[str] = field(default_factory=list)
    main_frame_blocked: bool = False


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


@contextmanager
def open_listing(
    url: str,
    *,
    setup: Callable[[BrowserContext], None] | None = None,
    profile_dir: Path | None = None,
) -> Iterator[ListingSession]:
    """Open a guarded Camoufox session on a checked listing page and keep it open."""
    try:
        canonical_url = canonical_listing_url(url)
    except InvalidListingURL as exc:
        raise CaptureError("access_blocked") from exc

    launch: dict = {
        "headless": True,
        "humanize": True,
        "firefox_user_prefs": {"network.http.redirection-limit": 0},
    }
    if profile_dir is not None:
        launch.update(
            persistent_context=True,
            user_data_dir=str(profile_dir),
            service_workers="block",
        )

    state = {"blocked_main_frame": False}
    session: ListingSession | None = None
    try:
        with Camoufox(**launch) as browser:
            try:
                if profile_dir is not None:
                    context = browser
                    page = context.pages[0] if context.pages else context.new_page()
                else:
                    context = browser.new_context(service_workers="block")
                    page = context.new_page()
                if setup is not None:
                    setup(context)
                session = ListingSession(page=page, context=context)
                _navigate(session, canonical_url, state)
            except CaptureError:
                raise
            except Exception as exc:
                if state["blocked_main_frame"]:
                    raise CaptureError("access_blocked") from exc
                raise CaptureError("temporary_failure") from exc
            yield session
    except CaptureError:
        raise
    except Exception as exc:
        if session is None:
            if state["blocked_main_frame"]:
                raise CaptureError("access_blocked") from exc
            raise CaptureError("temporary_failure") from exc
        raise


def _navigate(session: ListingSession, canonical_url: str, state: dict) -> None:
    page = session.page
    pending_main_frame_redirect: str | None = None

    def inspect_main_frame_response(response) -> None:
        nonlocal pending_main_frame_redirect
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
            state["blocked_main_frame"] = True
            session.main_frame_blocked = True

    page.on("response", inspect_main_frame_response)

    def guard_request(route) -> None:
        request = route.request
        is_main_frame = (
            request.is_navigation_request() and request.frame == page.main_frame
        )
        if not _allowed_url(request.url, main_frame=is_main_frame):
            if is_main_frame:
                state["blocked_main_frame"] = True
                session.main_frame_blocked = True
            entry = _blocked_entry(request.url)
            if entry not in session.blocked:
                session.blocked.append(entry)
            route.abort()
            return
        route.fallback()

    session.context.route("**/*", guard_request)
    current_url = canonical_url
    response = None
    navigation_deadline = time.monotonic() + _MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS
    for _ in range(_MAX_MAIN_FRAME_REDIRECTS + 1):
        remaining_timeout_ms = int((navigation_deadline - time.monotonic()) * 1000)
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
            if state["blocked_main_frame"]:
                raise CaptureError("access_blocked") from exc
            if pending_main_frame_redirect is not None:
                current_url = pending_main_frame_redirect
                continue
            raise CaptureError("temporary_failure") from exc
        if state["blocked_main_frame"]:
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


def capture_html(url: str) -> str:
    """Open a fresh Camoufox session and return a checked rendered document."""
    session: ListingSession | None = None
    try:
        with open_listing(url) as session:
            html = session.page.content()
            if session.main_frame_blocked:
                raise CaptureError("access_blocked")
            if error := _page_error(html):
                raise CaptureError(error)
            return html
    except CaptureError:
        raise
    except Exception as exc:
        if session is not None and session.main_frame_blocked:
            raise CaptureError("access_blocked") from exc
        raise CaptureError("temporary_failure") from exc
