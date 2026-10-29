"""Helpers for invisible browser sessions."""

import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from auto24_service.firefox_prefs import QUIET_FIREFOX_PREFS
from auto24_service.guard import SiteAllowlist

# invisible_core leaves Firefox's background services at retail defaults, so
# each launch would call Mozilla and GitHub. These prefs stop that traffic
# and none of them is visible to pages: the Push and Geolocation APIs stay.
# The network sandbox (scripts/network-sandbox offline --engine invisible)
# records any host that remains.
INVISIBLE_QUIET_PREFS = {
    **QUIET_FIREFOX_PREFS,
    "network.websocket.max-connections": 0,
    "invisible_firefox.usage_ping.enabled": False,
    "network.trr.mode": 5,
    "network.captive-portal-service.enabled": False,
    "network.connectivity-service.enabled": False,
    "dom.push.connection.enabled": False,
    "toolkit.telemetry.enabled": False,
    "toolkit.telemetry.unified": False,
    "toolkit.telemetry.archive.enabled": False,
    "datareporting.healthreport.uploadEnabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "app.normandy.enabled": False,
    "app.shield.optoutstudies.enabled": False,
    "browser.region.network.url": "",
    "browser.region.update.enabled": False,
    "browser.safebrowsing.malware.enabled": False,
    "browser.safebrowsing.phishing.enabled": False,
    "browser.safebrowsing.downloads.enabled": False,
    "browser.safebrowsing.provider.mozilla.updateURL": "",
    "extensions.update.enabled": False,
    "extensions.systemAddon.update.enabled": False,
    "extensions.getAddons.cache.enabled": False,
    "browser.newtabpage.enabled": False,
    "browser.newtabpage.activity-stream.feeds.section.topstories": False,
    "browser.newtabpage.activity-stream.feeds.topsites": False,
    "browser.newtabpage.activity-stream.showSponsored": False,
    "browser.newtabpage.activity-stream.showSponsoredTopSites": False,
    "browser.newtabpage.activity-stream.telemetry": False,
    "browser.topsites.contile.enabled": False,
    "browser.urlbar.suggest.quicksuggest.sponsored": False,
    "browser.search.update": False,
    "browser.ping-centre.telemetry": False,
    "datareporting.usage.uploadEnabled": False,
    "toolkit.telemetry.newProfilePing.enabled": False,
    "toolkit.telemetry.firstShutdownPing.enabled": False,
    "toolkit.telemetry.shutdownPingSender.enabled": False,
    "toolkit.telemetry.updatePing.enabled": False,
    "toolkit.telemetry.bhrPing.enabled": False,
}
# Release Firefox ignores a Remote Settings server override, and some telemetry
# pings ignore the prefs above. Firefox resolves these hosts to localhost
# without asking DNS.
LOCAL_DOMAINS = (
    "firefox.settings.services.mozilla.com",
    "firefox-settings-attachments.cdn.mozilla.net",
    "incoming.telemetry.mozilla.org",
)


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
                           keep_profile: Path | None = None, fake_hosts: tuple[str, ...] = ()):
    """Open one offline-configured Firefox session with the site's request guard.

    fake_hosts are hosts a test serves through routes; Firefox resolves them
    to localhost instead of asking DNS.
    """
    import threading
    from contextlib import ExitStack

    from invisible_core import _geo
    from invisible_playwright import InvisiblePlaywright
    from auto24_service.guard import allowed_url, blocked_entry
    from auto24_service.session import CaptureError, ListingSession

    if deadline is not None and time.monotonic() >= deadline:
        raise CaptureError('browser_launch')
    kill_time = deadline + 5 if deadline is not None else None

    def no_egress_discovery(*args, **kwargs):
        raise _geo.GeoTimezoneError('Egress IP discovery is disabled')

    import psutil

    # Match psutil's /proc clock: boot_time is rounded independently of wall time.
    started = psutil.boot_time() + time.clock_gettime(time.CLOCK_BOOTTIME)
    original_discover = _geo.discover_egress_ip
    _geo.discover_egress_ip = no_egress_discovery
    watchdog = None
    if kill_time is not None:
        watchdog = threading.Timer(max(0, kill_time - time.monotonic()),
                                   _kill_firefox_tree, (started,))
        watchdog.daemon = True
        watchdog.start()
    try:
        with ExitStack() as stack:
            try:
                options = dict(headless=True, locale='et-EE', timezone='Europe/Tallinn',
                               show_cursor=False,
                               extra_prefs={**INVISIBLE_QUIET_PREFS,
                                            'network.dns.localDomains':
                                                ','.join(LOCAL_DOMAINS + fake_hosts)})
                if keep_profile is not None:
                    options['profile_dir'] = keep_profile
                browser = stack.enter_context(InvisiblePlaywright(**options))
                # The watchdog may have fired before launch created Firefox.
                # Recheck after launch so that late browsers cannot escape it.
                if kill_time is not None and time.monotonic() >= kill_time:
                    _kill_firefox_tree(started)
                    raise CaptureError('browser_launch')
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
