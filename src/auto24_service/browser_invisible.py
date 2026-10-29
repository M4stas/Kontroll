"""Helpers for invisible browser sessions."""

import time
import json
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

from auto24_service.firefox_prefs import QUIET_FIREFOX_PREFS
from auto24_service.guard import SiteAllowlist

# invisible_core leaves Firefox's background services at retail defaults, so
# each launch would call Mozilla and GitHub. These prefs stop that traffic.
# The Push and Geolocation APIs stay present; a page that subscribes to push
# gets an error, as with a browser whose push service is unreachable. The
# network sandbox (scripts/network-sandbox offline --engine invisible) records
# any host that remains.
INVISIBLE_QUIET_PREFS = {
    **QUIET_FIREFOX_PREFS,
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


def _proxy_prefs(site: SiteAllowlist) -> dict:
    # PAC is a host-level backstop for redirects and WebSockets that bypass
    # HTTP routes. The route handlers still enforce paths and URL schemes.
    hosts = site.main_frame_hosts | site.subresource_hosts | frozenset(
        urlsplit(prefix).hostname for prefix in site.subresource_prefixes)
    pac = ('function FindProxyForURL(url, host) { return ' +
           json.dumps(sorted(hosts)) + '.indexOf(host) !== -1 ? "DIRECT" : "PROXY 127.0.0.1:9"; }')
    return {
        'network.proxy.type': 2,
        'network.proxy.autoconfig_url': 'data:application/x-ns-proxy-autoconfig,' + quote(pac, safe=''),
        'network.proxy.allow_hijacking_localhost': True,
        'network.proxy.no_proxies_on': '',
    }


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
                headers = response.headers
                if ('pdf' not in headers.get('content-type', '').lower()
                        and 'attachment' not in headers.get('content-disposition', '').lower()):
                    return
                # A candidate body that stalls is bounded by the session watchdog.
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
                                            **_proxy_prefs(site),
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
                context = browser.new_context(accept_downloads=False, service_workers='block')
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

            def record_target(request, target):
                main_frame = request.is_navigation_request() and request.frame == page.main_frame
                if not allowed_url(target, main_frame=main_frame, site=site):
                    entry = blocked_entry(target)
                    if entry not in session.blocked:
                        session.blocked.append(entry)
                    if main_frame:
                        session.main_frame_blocked = True

            def inspect_redirect(response):
                if not 300 <= response.status < 400:
                    return
                location = response.headers.get('location')
                if not location:
                    return
                record_target(response.request, urljoin(response.url, location))

            context.on('response', inspect_redirect)
            # Juggler omits the response event for a route-fulfilled redirect.
            # Observe attempted destinations too; only the PAC enforces these hops.
            context.on('request', lambda request: record_target(request, request.url))
            yield session
    finally:
        if watchdog is not None:
            watchdog.cancel()
        _geo.discover_egress_ip = original_discover
