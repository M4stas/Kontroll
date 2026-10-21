"""Capture rendered HTML from one public Auto24 listing."""

from __future__ import annotations

import sys
import time
import inspect
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from camoufox import DefaultAddons
from camoufox.sync_api import Camoufox
from playwright.sync_api import BrowserContext, Page

from auto24_service.contracts import AttemptRecord, Registration, RevealDiagnostics
from auto24_service.diagnostics import NULL_OBSERVER, PhaseObserver
from auto24_service.store import REVEAL_SECONDS
from auto24_service.guard import (
    ALLOWED_SUBRESOURCE_HOSTS,
    ALLOWED_SUBRESOURCE_PREFIXES,
    _UNSAFE_PATH_PARTS,
    allowed_url as _allowed_url,
    blocked_entry as _blocked_entry,
)
from auto24_service.urls import InvalidListingURL, canonical_listing_url

if TYPE_CHECKING:
    from auto24_service.captcha.solver import SolverLike

_REDIRECT_STATUS_CODES = frozenset({300, 301, 302, 303, 307, 308})
_MAX_MAIN_FRAME_REDIRECTS = 5
_MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS = 45
# The capture must end this long before the lease does, leaving time to parse and
# call complete() while the lease token is still valid. The reveal after completion
# keeps the same margin before its storage window closes.
LEASE_SAFETY_SECONDS = 15.0
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

class CaptureError(RuntimeError):
    """A stable browser failure that maps to a listing error code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass
class ListingSession:
    page: Page
    context: BrowserContext
    blocked: list[str] = field(default_factory=list)
    main_frame_blocked: bool = False
    extension_loaded: bool | None = None


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
    deadline: float | None = None,
    observer: PhaseObserver = NULL_OBSERVER,
) -> Iterator[ListingSession]:
    """Open a guarded Camoufox session on a checked listing page and keep it open.

    `observer` times browser start, page setup, navigation, validation and browser
    shutdown. Work done by the caller while the session is open is not timed here.
    """
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

    if deadline is not None:
        remaining = (deadline - time.monotonic()) * 1000
        if remaining <= 0:
            raise CaptureError("temporary_failure")
        launch["timeout"] = min(30000, max(1, remaining))

    state = {"blocked_main_frame": False}
    session: ListingSession | None = None
    try:
        manager = Camoufox(**launch)
        with observer.phase("browser_start"):
            browser = manager.__enter__()
        exc_info: tuple = (None, None, None)
        try:
            try:
                with observer.phase("page_setup"):
                    if profile_dir is not None:
                        context = browser
                        page = context.pages[0] if context.pages else context.new_page()
                    else:
                        context = browser.new_context(service_workers="block")
                        page = context.new_page()
                    if setup is not None:
                        setup(context)
                    session = ListingSession(page=page, context=context)
                    _install_guards(session, state)
                # The guards above are timed as page setup, so _navigate must not add them again.
                _navigate(
                    session,
                    canonical_url,
                    state,
                    deadline=deadline,
                    observer=observer,
                    install_guard=False,
                    observe_redirects=False,
                )
            except CaptureError:
                raise
            except Exception as exc:
                if state["blocked_main_frame"]:
                    raise CaptureError("access_blocked") from exc
                raise CaptureError("temporary_failure") from exc
            yield session
        except BaseException:
            exc_info = sys.exc_info()
            raise
        finally:
            with observer.phase("browser_shutdown"):
                manager.__exit__(*exc_info)
    except CaptureError:
        raise
    except Exception as exc:
        if session is None:
            if state["blocked_main_frame"]:
                raise CaptureError("access_blocked") from exc
            raise CaptureError("temporary_failure") from exc
        raise


def _navigate(
    session: ListingSession,
    canonical_url: str,
    state: dict,
    *,
    deadline: float | None = None,
    allowed_url: Callable[..., bool] | None = None,
    observe_redirects: bool = True,
    install_guard: bool = True,
    observer: PhaseObserver = NULL_OBSERVER,
) -> None:
    """Navigate a session to the listing and check the response.

    `install_guard` adds the context route guard and `observe_redirects` the
    main-frame redirect listener (see `_install_guards`). Callers that installed
    them already, or share another session's guard, pass False.
    """
    if allowed_url is None:
        allowed_url = _allowed_url
    if install_guard or observe_redirects:
        _install_guards(
            session,
            state,
            allowed_url=allowed_url,
            observe_redirects=observe_redirects,
            install_route=install_guard,
        )
    page = session.page
    with observer.phase("navigation"):
        current_url = canonical_url
        response = None
        navigation_deadline = time.monotonic() + _MAIN_FRAME_NAVIGATION_TIMEOUT_SECONDS
        if deadline is not None:
            navigation_deadline = min(navigation_deadline, deadline)
        for _ in range(_MAX_MAIN_FRAME_REDIRECTS + 1):
            remaining_timeout_ms = int((navigation_deadline - time.monotonic()) * 1000)
            if remaining_timeout_ms <= 0:
                raise CaptureError("temporary_failure")
            state["pending_main_frame_redirect"] = None
            try:
                response = page.goto(
                    current_url,
                    timeout=remaining_timeout_ms,
                    wait_until="domcontentloaded",
                )
            except Exception as exc:
                if state["blocked_main_frame"]:
                    raise CaptureError("access_blocked") from exc
                if state["pending_main_frame_redirect"] is not None:
                    current_url = state["pending_main_frame_redirect"]
                    continue
                raise CaptureError("temporary_failure") from exc
            if state["blocked_main_frame"]:
                raise CaptureError("access_blocked")
            if state["pending_main_frame_redirect"] is not None:
                current_url = state["pending_main_frame_redirect"]
                continue
            if response is not None and response.status in _REDIRECT_STATUS_CODES:
                location = response.headers.get("location")
                target_url = urljoin(current_url, location) if location else ""
                if not allowed_url(target_url, main_frame=True):
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


def _install_guards(
    session: ListingSession,
    state: dict,
    *,
    allowed_url: Callable[..., bool] | None = None,
    observe_redirects: bool = True,
    install_route: bool = True,
) -> None:
    """Block every request the capture may not load; record main-frame redirects."""
    if allowed_url is None:
        allowed_url = _allowed_url
    page = session.page
    state["pending_main_frame_redirect"] = None

    def inspect_main_frame_response(response) -> None:
        request = response.request
        if (
            not request.is_navigation_request()
            or request.frame != page.main_frame
            or response.status not in _REDIRECT_STATUS_CODES
        ):
            return
        location = response.headers.get("location")
        target_url = urljoin(response.url, location) if location else ""
        if allowed_url(target_url, main_frame=True):
            state["pending_main_frame_redirect"] = target_url
        else:
            state["blocked_main_frame"] = True
            session.main_frame_blocked = True

    def guard_request(route) -> None:
        request = route.request
        is_navigation = request.is_navigation_request()
        try:
            frame = request.frame
        except Exception as exc:
            # Patchright explicitly has no frame for a popup's first navigation.
            # Apply the stricter top-level policy before any network contact.
            if not is_navigation or "Frame for this navigation request is not available" not in str(exc):
                raise
            frame = None
        is_listing_frame = is_navigation and frame == page.main_frame
        # A top-level navigation in any page (a popup or a second tab) is guarded
        # like the main frame, so it can only load Auto24.
        is_top_level = is_navigation and (
            is_listing_frame or getattr(frame, "parent_frame", None) is None
        )
        if not allowed_url(request.url, main_frame=is_top_level):
            if is_listing_frame:
                state["blocked_main_frame"] = True
                session.main_frame_blocked = True
            entry = _blocked_entry(request.url)
            if entry not in session.blocked:
                session.blocked.append(entry)
            route.abort()
            return
        route.fallback()

    if observe_redirects:
        page.on("response", inspect_main_frame_response)
    if install_route:
        # A shared browser already has this guard on its context; a page opened
        # later in that context is covered by it, so it must not add another.
        session.context.route("**/*", guard_request)


def capture_html(url: str, observer: PhaseObserver = NULL_OBSERVER) -> str:
    """Open a fresh Camoufox session and return a checked rendered document."""
    session: ListingSession | None = None
    try:
        with open_listing(url, observer=observer) as session:
            return _checked_html(session, observer)
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


def _checked_html(session: ListingSession, observer: PhaseObserver = NULL_OBSERVER) -> str:
    with observer.phase("html_retrieval"):
        html = session.page.content()
    with observer.phase("validation"):
        if session.main_frame_blocked:
            raise CaptureError("access_blocked")
        if error := _page_error(html):
            raise CaptureError(error)
    return html


def _reveal_crashed(
    started_at: datetime, start: float, error_type: str | None = None
) -> tuple[Registration, RevealDiagnostics]:
    record = AttemptRecord(
        attempt=1,
        started_at=started_at,
        duration_ms=max(0, int((time.monotonic() - start) * 1000)),
        outcome="failed",
        reason="browser_error",
        error_type=error_type,
    )
    registration = Registration(reg_number_status="unavailable", vin_status="unavailable")
    return registration, RevealDiagnostics(attempts=[record])


class _SwitchableObserver:
    """Forwards phases to an observer until `stop()`; later phases are not timed."""

    def __init__(self, observer: PhaseObserver) -> None:
        self.observer = observer

    def phase(self, name):
        return self.observer.phase(name)

    def stop(self) -> None:
        self.observer = NULL_OBSERVER


def capture_listing(
    url: str,
    *,
    solver: SolverLike | None,
    force_failure: bool = False,
    engine: Literal["camoufox", "chromium"] = "camoufox",
    profile_dir: Path | None = None,
    save_image: Callable[[str, bytes], None] | None = None,
    opener: Callable[..., AbstractContextManager[ListingSession]] | None = None,
    reveal: Callable[..., object] | None = None,
    deadline: float | None = None,
    debug: Callable[..., None] | None = None,
    observer: PhaseObserver = NULL_OBSERVER,
    on_html: Callable[[str], bool] | None = None,
) -> CaptureResult:
    """Capture the checked listing HTML, then reveal the registration in the same session.

    The HTML is read before any click. A reveal failure or exception never fails the
    capture: both hidden fields become `unavailable` with reason `browser_error`.
    `deadline` is a `time.monotonic()` value the reveal must finish by; it keeps the
    whole capture inside the job lease. `observer` times the first session's phases
    (browser start to shutdown); the reveal and any retry session are not timed.

    `on_html`, when given, receives the checked HTML before the reveal and returns
    whether the job completed. On False the reveal is skipped and the result has no
    registration. On True the lease has ended, so the reveal and every retry session
    get a new deadline, `REVEAL_SECONDS - LEASE_SAFETY_SECONDS` from now, and the rest
    of the session is not timed.
    """
    if opener is None:
        opener = open_listing
    if reveal is None:
        from auto24_service.captcha.reveal import reveal_registration as reveal

    # Existing test/custom openers need not accept the new optional argument.
    parameters = inspect.signature(opener).parameters.values()
    accepts_deadline = any(p.name == "deadline" or p.kind == inspect.Parameter.VAR_KEYWORD for p in parameters)
    accepts_observer = any(p.name == "observer" or p.kind == inspect.Parameter.VAR_KEYWORD for p in parameters)
    open_options = {"deadline": deadline} if deadline is not None and accepts_deadline else {}
    session_observer = observer if on_html is None else _SwitchableObserver(observer)
    observer_options = (
        {"observer": session_observer} if observer is not NULL_OBSERVER and accepts_observer else {}
    )
    # Replaced once on_html completes the job: the lease no longer bounds the reveal.
    reveal_deadline = deadline

    def reopen(*, deadline: float | None = None) -> AbstractContextManager[ListingSession]:
        # The first session still holds profile_dir, so the retry uses a fresh profile.
        retry_options = {}
        if accepts_deadline and (deadline is not None or reveal_deadline is not None):
            retry_options["deadline"] = min(d for d in (deadline, reveal_deadline) if d is not None)
        return opener(url, profile_dir=None, **retry_options)

    # An opener that reuses another session's browser cannot be driven from a new thread.
    reopen.same_thread = bool(getattr(opener, "same_thread", False))  # type: ignore[attr-defined]

    result: CaptureResult | None = None
    session: ListingSession | None = None
    try:
        with opener(url, profile_dir=profile_dir, **open_options, **observer_options) as session:
            html = _checked_html(session, observer)
            if on_html is not None:
                if not on_html(html):
                    result = CaptureResult(html, None, None)
                    return result
                # Spans after completion would be rejected, so timing stops here.
                session_observer.stop()
                reveal_deadline = time.monotonic() + REVEAL_SECONDS - LEASE_SAFETY_SECONDS
            started_at, start = datetime.now(timezone.utc), time.monotonic()
            try:
                outcome = reveal(
                    session,
                    reopen,
                    solver,
                    force_failure=force_failure,
                    save_image=save_image,
                    **({} if debug is None else {"debug": debug}),
                    **({} if reveal_deadline is None else {"deadline": reveal_deadline}),
                )
                registration, diagnostics = outcome.registration, outcome.diagnostics
            except Exception as exc:
                registration, diagnostics = _reveal_crashed(started_at, start, type(exc).__name__)
            diagnostics.engine = engine
            diagnostics.extension_loaded = getattr(session, "extension_loaded", None)
            if engine == "chromium":
                for attempt in diagnostics.attempts:
                    attempt.solver = "extension"
                    for round_record in attempt.rounds:
                        round_record.solver = "extension"
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
