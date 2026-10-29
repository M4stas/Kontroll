"""Helpers for invisible browser sessions."""

import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from auto24_service.guard import SiteAllowlist


@dataclass
class PdfResponse:
    body: bytes | None = None


def recaptcha_badge_shown(page) -> bool:
    return bool(page.evaluate("() => !!document.querySelector('.grecaptcha-badge')"))


@contextmanager
def expect_pdf_response(page, timeout_ms: int):
    result = PdfResponse()
    end = time.monotonic() + timeout_ms / 1000

    def on_response(response):
        if result.body is None:
            try:
                body = response.body()
                if body.startswith(b"%PDF-"):
                    result.body = body
            except Exception:
                pass

    page.on("response", on_response)
    try:
        yield result
        while result.body is None and (remaining := end - time.monotonic()) > 0:
            page.wait_for_timeout(min(100, max(1, int(remaining * 1000))))
    finally:
        page.remove_listener("response", on_response)


def _kill_firefox_tree(started: float) -> None:
    """Kill only Firefox descendants created by this container's one session."""
    import psutil

    processes = []
    for process in psutil.Process().children(recursive=True):
        try:
            if process.create_time() >= started and 'firefox' in process.name().lower():
                processes.extend(process.children(recursive=True))
                processes.append(process)
        except psutil.NoSuchProcess:
            continue
    for process in reversed(processes):
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(processes, timeout=1)


@contextmanager
def open_invisible_session(*, site: SiteAllowlist, setup=None, deadline: float | None = None,
                           keep_profile: Path | None = None):
    """Open one offline-configured Firefox session with the site's request guard."""
    import threading
    from contextlib import ExitStack

    from invisible_core import _geo
    from invisible_playwright import InvisiblePlaywright
    from auto24_service.guard import allowed_url, blocked_entry
    from auto24_service.session import CaptureError, ListingSession

    def no_egress_discovery(*args, **kwargs):
        raise _geo.GeoTimezoneError('Egress IP discovery is disabled')

    import psutil

    # Match psutil's /proc clock: boot_time is rounded independently of wall time.
    started = psutil.boot_time() + time.clock_gettime(time.CLOCK_BOOTTIME)
    original_discover = _geo.discover_egress_ip
    _geo.discover_egress_ip = no_egress_discovery
    watchdog = None
    if deadline is not None:
        watchdog = threading.Timer(max(0, deadline + 5 - time.monotonic()),
                                   _kill_firefox_tree, (started,))
        watchdog.daemon = True
        watchdog.start()
    try:
        with ExitStack() as stack:
            try:
                options = dict(headless=True, locale='et-EE', timezone='Europe/Tallinn',
                               show_cursor=False,
                               extra_prefs={'network.websocket.max-connections': 0})
                if keep_profile is not None:
                    options['profile_dir'] = keep_profile
                browser = stack.enter_context(InvisiblePlaywright(**options))
                context = browser.new_context(accept_downloads=False)
                page = context.new_page()
            except Exception as exc:
                raise CaptureError('browser_launch') from exc
            session = ListingSession(page=page, context=context, engine='invisible')
            if setup is not None:
                setup(context)

            def guard_request(route):
                request = route.request
                navigation = request.is_navigation_request()
                frame = request.frame if navigation else None
                if not allowed_url(request.url, main_frame=navigation and frame.parent_frame is None,
                                   site=site):
                    if navigation and frame == page.main_frame:
                        session.main_frame_blocked = True
                    entry = blocked_entry(request.url)
                    if entry not in session.blocked:
                        session.blocked.append(entry)
                    route.abort()
                else:
                    route.fallback()

            context.route('**/*', guard_request)
            yield session
    finally:
        if watchdog is not None:
            watchdog.cancel()
        _geo.discover_egress_ip = original_discover
