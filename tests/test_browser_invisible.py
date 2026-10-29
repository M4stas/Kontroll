"""Offline integration coverage for guarded invisible sessions."""
import socket
import time
from contextlib import contextmanager
from functools import partial
from types import SimpleNamespace

import pytest

pytest.importorskip('invisible_playwright')
import psutil
from invisible_core import _geo
from auto24_service.browser_invisible import open_invisible_session, expect_pdf_response
from auto24_service.guard import MNT
from auto24_service.session import CaptureError
from auto24_service.mnt_lookup import lookup_background_check
from tests.fakesite.mnt import MntScenario, install_fake_mnt
SEARCH_URL = 'https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf'


@pytest.mark.parametrize('age', [0, 1, 6])
def test_expired_deadline_is_rejected_before_launch(monkeypatch, age):
    import invisible_playwright

    launches = []
    def launch(**kwargs):
        launches.append(kwargs)
        raise AssertionError('expired session attempted launch')
    monkeypatch.setattr(invisible_playwright, 'InvisiblePlaywright', launch)
    discover = _geo.discover_egress_ip
    with pytest.raises(CaptureError, match='^browser_launch$'):
        with open_invisible_session(site=MNT, deadline=time.monotonic() - age):
            pytest.fail('expired session was yielded')
    assert launches == []
    assert _geo.discover_egress_ip is discover


def test_slow_launch_after_watchdog_fires_is_killed_immediately(monkeypatch):
    import threading
    import invisible_playwright
    import auto24_service.browser_invisible as invisible

    now = [100.0]
    timers = []
    browsers = []
    killed_before_cleanup = []
    original_launch = invisible_playwright.InvisiblePlaywright
    started = psutil.boot_time() + time.clock_gettime(time.CLOCK_BOOTTIME)

    class ManualTimer:
        def __init__(self, interval, function, args):
            self.fire = lambda: function(*args)
            timers.append(self)
        def start(self):
            pass
        def cancel(self):
            pass

    @contextmanager
    def slow_launch(**kwargs):
        # Expire the watchdog before Firefox exists, then let launch finish.
        now[0] = 107.0
        timers[0].fire()
        with original_launch(**kwargs) as browser:
            browsers.extend(p for p in psutil.Process().children(recursive=True)
                            if p.create_time() >= started and 'firefox' in p.name().lower())
            assert browsers
            try:
                yield browser
            finally:
                killed_before_cleanup.append(all(
                    not p.is_running() or p.status() == psutil.STATUS_ZOMBIE for p in browsers))

    monkeypatch.setattr(threading, 'Timer', ManualTimer)
    monkeypatch.setattr(invisible, 'time', SimpleNamespace(
        monotonic=lambda: now[0], clock_gettime=time.clock_gettime,
        CLOCK_BOOTTIME=time.CLOCK_BOOTTIME))
    monkeypatch.setattr(invisible_playwright, 'InvisiblePlaywright', slow_launch)
    discover = _geo.discover_egress_ip
    with pytest.raises(CaptureError, match='^browser_launch$'):
        with open_invisible_session(site=MNT, deadline=101.0):
            pytest.fail('session survived the kill time')
    assert all(not p.is_running() or p.status() == psutil.STATUS_ZOMBIE for p in browsers)
    assert killed_before_cleanup == [True]
    assert _geo.discover_egress_ip is discover


def test_session_launches_with_no_network():
    with open_invisible_session(site=MNT) as session:
        assert session.engine == 'invisible'
        assert session.page.url == 'about:blank'
        assert session.page.evaluate('navigator.language') == 'et-EE'
        assert session.page.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone') == 'Europe/Tallinn'


def test_launch_never_calls_an_ip_echo_service(monkeypatch):
    hosts = []
    original = socket.getaddrinfo
    def record(host, *args, **kwargs):
        hosts.append(host)
        return original(host, *args, **kwargs)
    monkeypatch.setattr(socket, 'getaddrinfo', record)
    discover = _geo.discover_egress_ip
    with open_invisible_session(site=MNT):
        before = list(hosts)
        with pytest.raises(_geo.GeoTimezoneError):
            _geo.discover_egress_ip()
        assert hosts == before
    assert not {'api.ipify.org', 'icanhazip.com', 'checkip.amazonaws.com'}.intersection(hosts)
    assert _geo.discover_egress_ip is discover


def test_requests_outside_the_mnt_allowlist_are_blocked_and_recorded():
    served = []
    def setup(context):
        def handler(route):
            served.append(route.request.url)
            route.fulfill(content_type='text/html', body='''<p id="ok">form</p><script>
              for (const url of ['https://www.auto24.ee/soidukid/1',
                'https://www.googletagmanager.com/gtm.js?id=GTM-FAKE',
                'https://eteenindus.mnt.ee/resources/app.js']) fetch(url).catch(()=>{});
            </script>''' if route.request.url == SEARCH_URL else '')
        context.route('**/*', handler)
    with open_invisible_session(site=MNT, setup=setup) as session:
        session.page.goto(SEARCH_URL)
        session.page.wait_for_timeout(500)
        assert session.page.locator('#ok').inner_text() == 'form'
        with pytest.raises(Exception):
            session.page.goto('https://www.auto24.ee/soidukid/1')
        assert session.main_frame_blocked
        assert set(session.blocked) == {'www.auto24.ee/soidukid/', 'www.googletagmanager.com/gtm.js/'}
        assert 'https://eteenindus.mnt.ee/resources/app.js' in served
        assert not any('auto24' in url or 'googletagmanager' in url for url in served)


def test_websockets_are_refused():
    def setup(context):
        context.route('**/*', lambda r: r.fulfill(body='<html><body>socket</body></html>', content_type='text/html'))
    with open_invisible_session(site=MNT, setup=setup) as session:
        session.page.goto(SEARCH_URL)
        assert session.page.evaluate('''() => new Promise(resolve => {
          const s = new WebSocket('wss://eteenindus.mnt.ee/x');
          s.onerror = () => resolve('error'); s.onopen = () => resolve('open');
          setTimeout(() => resolve('timeout'), 2000);
        })''') == 'error'


@pytest.mark.parametrize('attachment,body', [(True, b'%PDF-fake'), (False, b'%PDF-inline'), (False, b'<html>error</html>')],
                         ids=['attachment', 'inline', 'html'])
def test_pdf_response_is_taken_without_a_download_event(attachment, body):
    def setup(context):
        def handler(route):
            if route.request.method == 'POST':
                route.fulfill(body=body, content_type='application/pdf' if body.startswith(b'%PDF-') else 'text/html',
                              headers={'Content-Disposition': 'attachment;filename=test.pdf'} if attachment else {})
            else:
                route.fulfill(body='<form method="post"><button>Salvestan</button></form>', content_type='text/html')
        context.route('**/*', handler)
    with open_invisible_session(site=MNT, setup=setup) as session:
        downloads = []
        session.page.on('download', lambda download: downloads.append(download))
        session.page.goto(SEARCH_URL)
        with expect_pdf_response(session.page, 2000) as result:
            session.page.get_by_text('Salvestan').click()
        assert result.body == (body if body.startswith(b'%PDF-') else None)
        assert downloads == []


def test_browser_is_killed_five_seconds_after_the_deadline():
    started = psutil.boot_time() + time.clock_gettime(time.CLOCK_BOOTTIME)
    deadline = time.monotonic() + 4
    browsers = []
    with open_invisible_session(site=MNT, deadline=deadline) as session:
        browsers = [p for p in psutil.Process().children(recursive=True)
                    if p.create_time() >= started and 'firefox' in p.name().lower()]
        assert browsers, [(p.name(), p.cmdline()) for p in psutil.Process().children(recursive=True)]
        with pytest.raises(Exception, match='closed|crash|Connection'):
            session.page.evaluate('new Promise(() => {})')
    assert deadline + 4 <= time.monotonic() < deadline + 6
    assert all(not p.is_running() or p.status() == psutil.STATUS_ZOMBIE for p in browsers)


def test_fetches_the_pdf_by_reg_number_on_the_fake_site():
    logs = []
    opener = partial(open_invisible_session, site=MNT,
                     setup=lambda c: logs.append(install_fake_mnt(c, MntScenario())))
    result = lookup_background_check('reg_number', '123ABC', time.monotonic() + 45, opener=opener)
    assert result.status == 'fetched'
    assert result.pdf.startswith(b'%PDF-')
    assert logs[0].searches[0]['soidukOtsingForm:regMark'] == '123ABC'
