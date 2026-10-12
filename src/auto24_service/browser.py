"""Capture rendered HTML from one public Auto24 listing."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from camoufox import DefaultAddons
from camoufox.sync_api import Camoufox
from playwright.sync_api import BrowserContext, Page

from auto24_service.contracts import AttemptRecord, Registration, RevealDiagnostics
from auto24_service.urls import InvalidListingURL, canonical_listing_url

if TYPE_CHECKING:
    from auto24_service.captcha.solver import SolverLike

ALLOWED_SUBRESOURCE_HOSTS = frozenset({"www.auto24.ee"})
ALLOWED_SUBRESOURCE_PREFIXES = (
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
)
_REDIRECT_STATUS_CODES = frozenset({300, 301, 302, 303, 307, 308})
_MAX_MAIN_FRAME_REDIRECTS = 5
_MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS = 45
# Firefox preferences that stop background traffic the capture never asked for.
# The network sandbox (scripts/network-sandbox offline) records any that remain.
QUIET_FIREFOX_PREFS = {
    "network.dns.disablePrefetch": True,
    "network.dns.disablePrefetchFromHTTPS": True,
    "network.prefetch-next": False,
    "network.predictor.enabled": False,
    "network.http.speculative-parallel-limit": 0,
    "browser.places.speculativeConnect.enabled": False,
    "browser.urlbar.speculativeConnect.enabled": False,
}
# A persistent profile must start on a blank page and never restore tabs.
PROFILE_NO_RESTORE_PREFS = {
    "browser.startup.page": 0,
    "browser.sessionstore.resume_from_crash": False,
}
# uBlock Origin, bundled by Camoufox, downloads filter lists from many hosts.
# The route guard already limits what pages may load.
QUIET_EXCLUDED_ADDONS = [DefaultAddons.UBO]
# Literal path traversal, and any percent escape, which could step out of an allowed
# prefix (including double encoding such as %252e%252e). reCAPTCHA paths need none.
_UNSAFE_PATH_PARTS = ("..", "%", "\\")


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
    path = parts.path.casefold()
    if any(part in path for part in _UNSAFE_PATH_PARTS):
        return False
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
        "firefox_user_prefs": {"network.http.redirection-limit": 0, **QUIET_FIREFOX_PREFS},
        "exclude_addons": QUIET_EXCLUDED_ADDONS,
        "block_webrtc": True,
    }
    if profile_dir is not None:
        # Never restore a previous session's pages: they would load before the guard.
        launch["firefox_user_prefs"].update(PROFILE_NO_RESTORE_PREFS)
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
        is_navigation = request.is_navigation_request()
        is_listing_frame = is_navigation and request.frame == page.main_frame
        # A top-level navigation in any page (a popup or a second tab) is guarded
        # like the main frame, so it can only load Auto24.
        is_top_level = is_navigation and (
            is_listing_frame or getattr(request.frame, "parent_frame", None) is None
        )
        if not _allowed_url(request.url, main_frame=is_top_level):
            if is_listing_frame:
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


@dataclass
class CaptureResult:
    html: str
    registration: Registration | None
    reveal_diagnostics: RevealDiagnostics | None


def _checked_html(session: ListingSession) -> str:
    html = session.page.content()
    if session.main_frame_blocked:
        raise CaptureError("access_blocked")
    if error := _page_error(html):
        raise CaptureError(error)
    return html


def _reveal_crashed(started_at: datetime, start: float) -> tuple[Registration, RevealDiagnostics]:
    record = AttemptRecord(
        attempt=1,
        started_at=started_at,
        duration_ms=max(0, int((time.monotonic() - start) * 1000)),
        outcome="failed",
        reason="browser_error",
    )
    registration = Registration(reg_number_status="unavailable", vin_status="unavailable")
    return registration, RevealDiagnostics(attempts=[record])


def capture_listing(
    url: str,
    *,
    solver: SolverLike,
    force_failure: bool = False,
    profile_dir: Path | None = None,
    save_image: Callable[[str, bytes], None] | None = None,
    opener: Callable[..., AbstractContextManager[ListingSession]] | None = None,
    reveal: Callable[..., object] | None = None,
    deadline: float | None = None,
) -> CaptureResult:
    """Capture the checked listing HTML, then reveal the registration in the same session.

    The HTML is read before any click. A reveal failure or exception never fails the
    capture: both hidden fields become `unavailable` with reason `browser_error`.
    `deadline` is a `time.monotonic()` value the reveal must finish by; it keeps the
    whole capture inside the job lease.
    """
    if opener is None:
        opener = open_listing
    if reveal is None:
        from auto24_service.captcha.reveal import reveal_registration as reveal

    def reopen() -> AbstractContextManager[ListingSession]:
        # The first session still holds profile_dir, so the retry uses a fresh profile.
        return opener(url, profile_dir=None)

    result: CaptureResult | None = None
    session: ListingSession | None = None
    try:
        with opener(url, profile_dir=profile_dir) as session:
            html = _checked_html(session)
            started_at, start = datetime.now(timezone.utc), time.monotonic()
            try:
                outcome = reveal(
                    session,
                    reopen,
                    solver,
                    force_failure=force_failure,
                    save_image=save_image,
                    **({} if deadline is None else {"deadline": deadline}),
                )
                registration, diagnostics = outcome.registration, outcome.diagnostics
            except Exception:
                registration, diagnostics = _reveal_crashed(started_at, start)
            result = CaptureResult(html, registration, diagnostics)
    except CaptureError:
        if result is None:
            raise
    except Exception as exc:
        if result is None:
            if session is not None and session.main_frame_blocked:
                raise CaptureError("access_blocked") from exc
            raise CaptureError("temporary_failure") from exc
    assert result is not None
    return result
