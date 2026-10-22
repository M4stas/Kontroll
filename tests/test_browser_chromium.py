"""Offline real Chromium launcher checks; requires the pinned Chromium image."""
import concurrent.futures
import contextlib
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest

if not Path(os.environ.get('CHROMIUM_EXECUTABLE', '/missing')).is_file():
    pytest.skip('Chromium image only', allow_module_level=True)

from auto24_service.browser import CaptureError
from auto24_service.browser_chromium import extension_id_for_path, open_chromium_listing, sweep_leftovers, _ready, _identity
from tests.fakesite import LISTING_URL, Scenario, install_fake_site

STUB = Path('/app/tests/fixtures/stub-extension')
REAL = Path('/opt/captcharaptor-extension')


def open_stub(**kwargs):
    return open_chromium_listing(LISTING_URL, setup=lambda ctx: install_fake_site(ctx, Scenario()), extension_dir=STUB, **kwargs)


def variant(tmp_path, script):
    dest = tmp_path / 'extension'
    shutil.copytree(STUB, dest)
    (dest / 'background.js').write_text(script)
    return dest


def test_extension_id_for_path_matches_chromium():
    with open_chromium_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as s:
        assert s.context.service_workers[0].url == f'chrome-extension://{extension_id_for_path(REAL)}/background.js'


def test_opens_the_fake_listing_with_the_extension_ready():
    with open_stub() as s:
        assert s.extension_loaded is True
        assert s.page.url == LISTING_URL


def test_launch_uses_the_configured_executable_directly(monkeypatch):
    from patchright.sync_api import BrowserType
    original = BrowserType.launch_persistent_context
    seen = []
    def launch(self, *args, **kwargs):
        seen.append(kwargs['executable_path'])
        return original(self, *args, **kwargs)
    monkeypatch.setattr(BrowserType, 'launch_persistent_context', launch)
    with open_stub() as session:
        assert session.extension_loaded
    assert seen == [os.environ['CHROMIUM_EXECUTABLE']]


def test_existing_worker_is_found_without_waiting(monkeypatch):
    with open_stub() as s:
        monkeypatch.setattr(type(s.context), 'wait_for_event', lambda *a, **k: pytest.fail('existing worker missed'))
        _ready(s.context, extension_id_for_path(STUB), None)


def test_wrong_extension_id_is_not_ready(tmp_path):
    other = variant(tmp_path, 'self.queryPhash = async () => [];')
    with open_stub() as s:
        with pytest.raises(CaptureError, match='extension_not_loaded'):
            _ready(s.context, extension_id_for_path(other), time.monotonic() + .2)


def test_failed_sqlite_probe_is_not_ready(tmp_path):
    ext = variant(tmp_path, 'self.queryPhash = async () => { throw Error("fake probe failure"); };')
    with pytest.raises(CaptureError, match='extension_not_loaded'):
        with open_chromium_listing(LISTING_URL, extension_dir=ext):
            pass


def test_readiness_never_waits_past_the_deadline(tmp_path):
    ext = variant(tmp_path, 'self.queryPhash = () => new Promise(() => {});')
    started = time.monotonic()
    with pytest.raises(CaptureError, match='extension_not_loaded'):
        with open_chromium_listing(LISTING_URL, extension_dir=ext, deadline=started + 1):
            pass
    assert time.monotonic() - started < 2


def test_page_fetch_to_a_foreign_host_is_blocked():
    with open_stub() as s:
        assert s.page.evaluate("fetch('https://example.org/x').then(() => false, () => true)")
        assert 'example.org/x/' in s.blocked


WEBSOCKET_ATTEMPT = '''url => new Promise(resolve => {
    window.socketAttempts = (window.socketAttempts || 0) + 1;
    const socket = new WebSocket(url);
    socket.onclose = () => resolve('closed');
    socket.onerror = () => resolve('error');
    socket.onopen = () => { socket.close(); resolve('open'); };
    setTimeout(() => resolve('timeout'), 1000);
})'''

WORKER_ATTEMPT = '''url => new Promise(resolve => {
    const code = `const s = new WebSocket(${JSON.stringify(url)});
      s.onopen = () => postMessage('open'); s.onerror = () => postMessage('error'); s.onclose = () => postMessage('closed');`;
    const worker = new Worker(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})));
    worker.onmessage = event => resolve(event.data);
    worker.onerror = () => resolve('worker_failed');
    setTimeout(() => resolve('timeout'), 1000);
})'''


@pytest.fixture
def socket_target():
    """Loopback server that records every accepted TCP connection."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(400)
            self.end_headers()
        def log_message(self, *args):
            pass

    class Server(ThreadingHTTPServer):
        connections = []
        def get_request(self):
            sock, address = super().get_request()
            self.connections.append(address)
            return sock, address

    server = Server(('127.0.0.1', 0), Handler)
    server.connections = []
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_socket_target_counts_unguarded_contact(socket_target):
    # Proves the zero-contact assertions below are not vacuous.
    import socket
    socket.create_connection(('127.0.0.1', socket_target.server_port)).close()
    end = time.monotonic() + 2
    while not socket_target.connections and time.monotonic() < end:
        time.sleep(0.02)
    assert len(socket_target.connections) == 1


@pytest.mark.parametrize('source,scheme', [('listing', 'wss'), ('blank', 'ws'), ('new_listing', 'wss'), ('inline_listing', 'wss')])
def test_websockets_never_contact_forbidden_target(source, scheme, socket_target, monkeypatch):
    url = f'{scheme}://127.0.0.1:{socket_target.server_port}/forbidden/private?token=secret'
    if source == 'inline_listing':
        import tests.fakesite as fake
        original_page = fake._page
        def source_page(name, **values):
            html = original_page(name, **values)
            if name == 'listing.html':
                script = f'window.websocketResult = Promise.all([({WEBSOCKET_ATTEMPT})({json.dumps(url)}), ({WEBSOCKET_ATTEMPT})({json.dumps(url)})]);'
                html = html.replace('</body>', f'<script>{script}</script></body>')
            return html
        monkeypatch.setattr(fake, '_page', source_page)
    with open_stub() as s:
        page = s.page if source in ('listing', 'inline_listing') else s.context.new_page()
        if source == 'new_listing':
            page.goto(LISTING_URL)
        assert page.url == ('about:blank' if source == 'blank' else LISTING_URL)
        if source == 'inline_listing':
            results = page.evaluate('window.websocketResult', isolated_context=False)
        else:
            results = [page.evaluate(WEBSOCKET_ATTEMPT, url, isolated_context=False) for _ in range(2)]
        assert all(result in ('closed', 'error') for result in results)
        assert page.evaluate('window.socketAttempts', isolated_context=False) == 2
        assert socket_target.connections == []
        assert s.blocked.count('127.0.0.1/forbidden/') == 1
        assert not any('secret' in entry or 'private' in entry for entry in s.blocked)


def test_worker_websocket_never_contacts_forbidden_target(socket_target):
    url = f'wss://127.0.0.1:{socket_target.server_port}/forbidden/'
    with open_stub() as s:
        results = [s.page.evaluate(WORKER_ATTEMPT, url, isolated_context=False) for _ in range(2)]
        assert all(result in ('closed', 'error') for result in results)
        assert socket_target.connections == []


def test_missing_websocket_guard_fails_closed(monkeypatch, tmp_path):
    import auto24_service.browser_chromium as launcher
    monkeypatch.setattr(launcher, 'WEBSOCKET_GUARD', tmp_path / 'missing')
    with pytest.raises(CaptureError, match='browser_launch'):
        with open_stub():
            pytest.fail('session opened without the WebSocket guard')


def test_inactive_websocket_guard_fails_closed(monkeypatch, tmp_path):
    # Valid extension, indexed by Chromium, but with no blocking rule.
    import auto24_service.browser_chromium as launcher
    inactive = tmp_path / 'guard'
    shutil.copytree(launcher.WEBSOCKET_GUARD, inactive)
    (inactive / 'rules.json').write_text('[]')
    monkeypatch.setattr(launcher, 'WEBSOCKET_GUARD', inactive)
    with pytest.raises(CaptureError, match='browser_launch'):
        with open_stub():
            pytest.fail('session opened without an active WebSocket block')


def test_comma_in_profile_path_fails_closed(tmp_path):
    with pytest.raises(CaptureError, match='browser_launch'):
        with open_stub(profile_dir=tmp_path / 'a,b'):
            pytest.fail('session opened with a split extension list')


def test_website_service_worker_cannot_register():
    with open_stub() as s:
        assert s.page.evaluate("navigator.serviceWorker.register('/sw.js').then(() => false, () => true)")
        assert s.page.evaluate('navigator.serviceWorker.getRegistrations().then(x => x.length)') == 0


def test_extension_worker_fetch_to_a_foreign_host_fails(tmp_path):
    ext = variant(tmp_path, 'self.queryPhash = async () => [];')
    manifest = json.loads((ext / 'manifest.json').read_text())
    manifest['content_security_policy'] = json.loads((REAL / 'manifest.json').read_text())['content_security_policy']
    (ext / 'manifest.json').write_text(json.dumps(manifest))
    with open_chromium_listing(LISTING_URL, extension_dir=ext, setup=lambda c: install_fake_site(c, Scenario())) as s:
        result = s.context.service_workers[0].evaluate('''async () => {
          const events = []; self.addEventListener('securitypolicyviolation', e => events.push(e.effectiveDirective));
          const rejected = await fetch('https://example.org/').then(() => false, () => true);
          await new Promise(r => setTimeout(r, 50)); return {rejected, events};
        }''')
        assert result['rejected']
        assert 'connect-src' in result['events']


def processes(profile):
    return [p for p in Path('/proc').iterdir() if p.name.isdigit() and (p / 'cmdline').exists() and str(profile).encode() in (p / 'cmdline').read_bytes()]


@pytest.mark.parametrize('mode', ['normal', 'exception', 'launch', 'readiness'])
def test_cleanup_on_every_exit(tmp_path, monkeypatch, mode):
    if mode == 'launch': monkeypatch.setenv('CHROMIUM_EXECUTABLE', '/missing/chrome')
    options = {'profile_dir': tmp_path}
    if mode == 'readiness': options['extension_dir'] = variant(tmp_path, 'self.queryPhash = async () => { throw Error(); };')
    groups = []
    try:
        with open_chromium_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario()), **({'extension_dir': STUB} | options)):
            profile = next(tmp_path.glob('a24-chromium-*'))
            groups = [json.loads((profile / 'chrome.json').read_text())['pid'], json.loads((profile / 'session.json').read_text())['xvfb']['pid']]
            if mode == 'exception': raise ValueError('fake failure')
    except (CaptureError, ValueError):
        assert mode != 'normal'
    assert not list(tmp_path.glob('a24-chromium-*'))
    assert_no_groups(groups)
    assert not processes(tmp_path / 'a24-chromium-')


@pytest.mark.parametrize("before_marker", [False, True])
def test_startup_sweeps_leftovers_from_a_killed_worker(tmp_path, before_marker):
    code = f'''from pathlib import Path
from tests.test_browser_chromium import open_stub
import time
if {before_marker!r}:
 original_write = Path.write_text
 def write(path, *args, **kwargs):
  if path.name in ('chrome.json', 'chrome.tmp'):
   print('READY', flush=True)
   time.sleep(60)
  return original_write(path, *args, **kwargs)
 Path.write_text = write
with open_stub(profile_dir=Path({str(tmp_path)!r})):
 print('READY', flush=True)
 time.sleep(60)
'''
    child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'READY'
        profile = next(tmp_path.glob('a24-chromium-*'))
        chrome_pids = [int(p.name) for p in processes(profile) if os.getpgid(int(p.name)) == int(p.name)]
        assert chrome_pids
        groups = chrome_pids + [json.loads((profile / 'session.json').read_text())['xvfb']['pid']]
        if before_marker:
            (profile / 'chrome.json').unlink(missing_ok=True)
        child.kill(); child.wait()
        assert sweep_leftovers(tmp_path) >= 1
        assert not list(tmp_path.glob('a24-chromium-*'))
        assert_no_groups(groups)
        assert not processes(tmp_path / 'a24-chromium-')
    finally:
        if child.poll() is None: child.kill(); child.wait()


def test_two_sessions_get_their_own_display_and_profile(tmp_path):
    import threading
    barrier = threading.Barrier(2)
    def run(_):
        with open_stub(profile_dir=tmp_path) as s:
            barrier.wait(timeout=15)
            markers = [json.loads(p.read_text()) for p in tmp_path.glob('*/session.json')]
            assert len({m['display'] for m in markers}) == 2
            return str(s.page.url)
    with concurrent.futures.ThreadPoolExecutor(2) as executor:
        assert list(executor.map(run, range(2))) == [LISTING_URL] * 2


def test_headless_flag_skips_xvfb(tmp_path):
    with open_stub(profile_dir=tmp_path, headless=True):
        marker = json.loads(next(tmp_path.glob('*/session.json')).read_text())
        assert marker['display'] is None
        assert not marker['xvfb']
        chrome = json.loads(next(tmp_path.glob('*/chrome.json')).read_text())
        assert b'--headless=new' in Path(f"/proc/{chrome['pid']}/cmdline").read_bytes().split(b'\0')


def test_headless_sends_the_image_user_agent(tmp_path):
    agent = os.environ['CHROMIUM_USER_AGENT']
    assert 'Headless' not in agent
    with open_stub(profile_dir=tmp_path, headless=True) as s:
        assert s.page.evaluate('navigator.userAgent') == agent


def test_headed_keeps_the_browser_user_agent(tmp_path, monkeypatch):
    monkeypatch.setenv('CHROMIUM_USER_AGENT', 'test-agent')
    with open_stub(profile_dir=tmp_path, headless=False) as s:
        assert s.page.evaluate('navigator.userAgent') != 'test-agent'


def assert_no_groups(groups):
    # Reparented zombies are already dead and cannot retain resources. Check all
    # group members, including Xvfb whose command line lacks the profile path.
    end = time.monotonic() + 2
    while True:
        alive = []
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit(): continue
            try:
                fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) in groups and fields[0] != 'Z': alive.append(proc.name)
            except (OSError, IndexError): pass
        if not alive: return
        assert time.monotonic() < end, alive
        time.sleep(.02)


def test_sweep_skips_active_session(tmp_path):
    with open_stub(profile_dir=tmp_path) as s:
        assert sweep_leftovers(tmp_path) == 0
        assert s.page.url == LISTING_URL


def test_sweep_does_not_kill_reused_pid(tmp_path):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
    try:
        identity = _identity(child.pid)
        identity['start'] = str(int(identity['start']) + 1)
        profile = tmp_path / 'a24-chromium-stale'
        profile.mkdir()
        (profile / 'session.json').write_text(json.dumps({'xvfb': identity}))
        assert sweep_leftovers(tmp_path) == 1
        assert child.poll() is None
    finally:
        child.kill(); child.wait()


def test_fallback_discovery_rejects_a_process_replaced_during_scan(tmp_path, monkeypatch):
    from auto24_service import browser_chromium
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                             env=dict(os.environ, AUTO24_CHROMIUM_PROFILE=str(tmp_path)),
                             start_new_session=True)
    try:
        original = _identity(child.pid)
        calls = []
        def identity(pid):
            if pid != child.pid:
                return _identity(pid)
            calls.append(pid)
            return original if len(calls) == 1 else dict(original, start='reused')
        monkeypatch.setattr(browser_chromium, '_identity', identity)
        marker = {'chromium_executable': str(Path(sys.executable).resolve())}
        assert browser_chromium._session_groups(tmp_path, marker) == []
    finally:
        child.kill(); child.wait()


def test_sweep_recovers_when_killed_during_session_metadata_write(tmp_path):
    code = f'''from pathlib import Path
from tests.test_browser_chromium import open_stub
import time
original_write = Path.write_text
def write(path, *args, **kwargs):
 if path.name in ('session.json', 'session.tmp') and path.with_name('session.json').exists():
  path.open('w').close()
  print('READY', flush=True)
  time.sleep(60)
 return original_write(path, *args, **kwargs)
Path.write_text = write
with open_stub(profile_dir=Path({str(tmp_path)!r})):
 raise AssertionError('metadata write was not intercepted')
'''
    child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
    groups = []
    try:
        assert child.stdout.readline().strip() == 'READY'
        profile = next(tmp_path.glob('a24-chromium-*'))
        token = f'AUTO24_CHROMIUM_PROFILE={profile}'.encode()
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit(): continue
            try:
                if token in (proc / 'environ').read_bytes().split(b'\0') and os.getpgid(int(proc.name)) == int(proc.name):
                    groups.append(int(proc.name))
            except OSError: pass
        assert groups
        child.kill(); child.wait()
        assert sweep_leftovers(tmp_path) == 1
        assert_no_groups(groups)
        assert not profile.exists()
    finally:
        if child.poll() is None: child.kill(); child.wait()
        for group in groups:
            try: os.killpg(group, 9)
            except ProcessLookupError: pass


@pytest.mark.parametrize('kind', ['main_frame', 'iframe', 'fetch', 'popup', 'new_page'])
@pytest.mark.parametrize('chain', ['blocked', 'allowed', 'mixed'])
def test_redirect_never_contacts_disallowed_target(monkeypatch, kind, chain):
    """Real HTTP redirects must be stopped before the foreign origin is hit."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from urllib.parse import urlsplit
    from auto24_service import browser, browser_chromium

    hits = {'source': 0, 'middle': 0, 'target': 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/redirect':
                hits['source'] += 1
                self.send_response(302)
                host = 'localhost' if chain == 'blocked' else '127.0.0.1'
                path = '/target' if chain == 'blocked' else '/middle'
                self.send_header('Location', f'http://{host}:{self.server.server_port}{path}')
                self.end_headers()
                return
            if self.path == '/middle':
                hits['middle'] += 1
                self.send_response(302)
                host = 'localhost' if chain == 'mixed' else '127.0.0.1'
                self.send_header('Location', f'http://{host}:{self.server.server_port}/target')
                self.end_headers()
                return
            if self.path == '/target':
                hits['target'] += 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body>Offline fixture</body></html>')

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    start = origin + ('/redirect' if kind == 'main_frame' else '/page')
    original_allowed = browser_chromium.allowed_url

    def fixture_allowed(url, *, main_frame, extension_id):
        parsed = urlsplit(url)
        if parsed.scheme == 'http':
            return parsed.hostname == '127.0.0.1' and parsed.port == server.server_port
        return original_allowed(url, main_frame=main_frame, extension_id=extension_id)

    monkeypatch.setattr(browser_chromium, 'allowed_url', fixture_allowed)
    monkeypatch.setattr(browser_chromium, 'canonical_listing_url', lambda _url: start)
    # Local redirect aliases represent the same synthetic listing.
    monkeypatch.setattr(browser, 'canonical_listing_url',
                        lambda url: start if urlsplit(url).hostname == '127.0.0.1' else url)
    error = None
    try:
        try:
            with open_chromium_listing(LISTING_URL, extension_dir=STUB) as session:
                if kind == 'fetch':
                    session.page.evaluate("fetch('/redirect').then(() => true, () => false)")
                elif kind == 'iframe':
                    session.page.evaluate('''() => new Promise(resolve => {
                        const frame = document.createElement('iframe');
                        frame.onload = frame.onerror = () => resolve();
                        frame.src = '/redirect'; document.body.append(frame);
                    })''')
                elif kind == 'popup':
                    with session.context.expect_page() as opened:
                        session.page.evaluate("window.open('/redirect')")
                    opened.value.wait_for_load_state('domcontentloaded')
                elif kind == 'new_page':
                    page = session.context.new_page()
                    try:
                        page.goto(origin + '/redirect', wait_until='domcontentloaded')
                    except Exception:
                        assert chain != 'allowed'
                if chain == 'allowed' and kind == 'main_frame':
                    assert session.page.url == origin + '/target'
                if chain != 'allowed' and kind != 'main_frame':
                    assert 'localhost/target/' in session.blocked
                session.page.wait_for_timeout(200)
        except CaptureError as exc:
            error = exc.code
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    print(f'REDIRECT_PROOF kind={kind} chain={chain} hits={hits} error={error}')
    assert hits['source'] == 1, hits
    assert hits['middle'] == (0 if chain == 'blocked' else 1), hits
    assert hits['target'] == (1 if chain == 'allowed' else 0), hits
    if kind == 'main_frame' and chain != 'allowed':
        assert error == 'access_blocked'
    else:
        assert error is None


def test_shared_mode_page_is_guarded_and_closed():
    from auto24_service.browser_chromium import shared_page_opener

    with open_stub() as s:
        opener = shared_page_opener(s, extension_dir=STUB)
        routes = []
        original = s.context.route
        s.context.route = lambda *a, **k: routes.append(a) or original(*a, **k)
        with opener(LISTING_URL) as shared:
            assert shared.page is not s.page and shared.page.url == LISTING_URL
            assert shared.page.evaluate("fetch('https://example.org/y').then(() => false, () => true)")
            assert 'example.org/y/' in s.blocked
            assert len(s.context.pages) == 2
        assert len(s.context.pages) == 1
        assert routes == []
        with pytest.raises(CaptureError) as error:
            with opener('https://example.org/x'):
                pass
        assert error.value.code == 'access_blocked'


class Observer:
    def __init__(self):
        self.events = []

    @contextlib.contextmanager
    def phase(self, name):
        try:
            yield
        except BaseException:
            self.events.append((name, 'failed'))
            raise
        else:
            self.events.append((name, 'complete'))


def test_chromium_session_reports_the_capture_phases():
    from auto24_service.browser_chromium import shared_page_opener

    observer = Observer()
    with open_stub(observer=observer) as s:
        assert observer.events == [(name, 'complete') for name in ['browser_start', 'page_setup', 'navigation', 'validation']]
        shared_observer = Observer()
        with shared_page_opener(s, extension_dir=STUB)(LISTING_URL, observer=shared_observer):
            pass
        assert shared_observer.events == [(name, 'complete') for name in ['page_setup', 'navigation', 'validation']]
    assert observer.events[-1] == ('browser_shutdown', 'complete')


def test_kept_profile_survives_the_session_and_keeps_cookies(tmp_path):
    profile = tmp_path / 'profile-1'
    with open_stub(keep_profile=profile) as session:
        session.page.evaluate("document.cookie = 'fake=123ABC; max-age=3600; path=/'", isolated_context=False)
    assert profile.is_dir()
    seen = []
    def setup(context):
        install_fake_site(context, Scenario())
        context.on('request', lambda request: seen.append(request.headers.get('cookie', '')))
    with open_chromium_listing(LISTING_URL, extension_dir=STUB, setup=setup, keep_profile=profile):
        pass
    assert any('fake=123ABC' in cookie for cookie in seen)


def test_kept_profile_is_not_swept(tmp_path):
    profile = tmp_path / 'profile-1'
    with open_stub(keep_profile=profile):
        pass
    assert sweep_leftovers(tmp_path) == 0
    assert profile.is_dir()


def test_concurrent_use_of_a_kept_profile_fails_closed(tmp_path, monkeypatch):
    profile = tmp_path / 'profile-1'
    with open_stub(keep_profile=profile) as session:
        marker = (profile / 'session.json').read_bytes()
        def attempt():
            with pytest.raises(CaptureError, match='browser_launch'):
                with open_stub(keep_profile=profile):
                    pytest.fail('opened a locked profile')
        import auto24_service.browser_chromium as launcher
        with monkeypatch.context() as patch:
            patch.setattr(launcher, 'sweep_leftovers', lambda root: pytest.fail('swept before taking the lock'))
            patch.setattr(launcher, '_cleanup_groups', lambda *args: pytest.fail('cleaned a locked profile'))
            with concurrent.futures.ThreadPoolExecutor(1) as executor:
                executor.submit(attempt).result(timeout=15)
        assert (profile / 'session.json').read_bytes() == marker
        assert session.page.evaluate('1 + 1') == 2


def test_kept_profile_lock_is_released_when_shutdown_fails(tmp_path, monkeypatch):
    import auto24_service.browser_chromium as launcher

    profile = tmp_path / 'profile-1'
    cleanup_groups = launcher._cleanup_groups
    original_wait = subprocess.Popen.wait
    reaped = []

    def track_wait(process, *args, **kwargs):
        result = original_wait(process, *args, **kwargs)
        if process.args[0] == 'Xvfb':
            reaped.append(process.pid)
        return result

    monkeypatch.setattr(subprocess.Popen, 'wait', track_wait)

    def fail_after_cleanup(*args):
        cleanup_groups(*args)
        raise RuntimeError('shutdown failed')

    with pytest.raises(RuntimeError, match='shutdown failed') as failure:
        with open_stub(keep_profile=profile):
            monkeypatch.setattr(launcher, '_cleanup_groups', fail_after_cleanup)

    assert reaped
    # Keep the exception and its generator traceback alive during reacquisition.
    assert failure.value.__traceback__ is not None
    with (profile / 'owner.lock').open('a') as another_lock:
        fcntl.flock(another_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


@pytest.mark.parametrize('kill_chromium', [True, False])
def test_kept_profile_recovers_after_a_killed_session(tmp_path, kill_chromium):
    profile = tmp_path / 'profile-1'
    code = f'''from pathlib import Path
from tests.test_browser_chromium import open_stub
import time
with open_stub(keep_profile=Path({str(profile)!r})):
 print('READY', flush=True)
 time.sleep(60)
'''
    child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
    groups = []
    try:
        assert child.stdout.readline().strip() == 'READY'
        chrome = json.loads((profile / 'chrome.json').read_text())['pid']
        groups = [chrome, json.loads((profile / 'session.json').read_text())['xvfb']['pid']]
        if kill_chromium:
            os.killpg(chrome, 9)
        child.kill(); child.wait()
        for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
            path = profile / name
            path.unlink(missing_ok=True)
            path.symlink_to(profile / 'missing')
        with open_stub(keep_profile=profile) as session:
            assert session.page.url == LISTING_URL
            assert_no_groups(groups)
    finally:
        if child.poll() is None: child.kill(); child.wait()
        for group in groups:
            try: os.killpg(group, 9)
            except ProcessLookupError: pass


@pytest.mark.parametrize('contents', ['not json', '[]', '{"xvfb": [], "chromium_executable": []}'])
def test_kept_profile_ignores_malformed_old_markers(tmp_path, contents):
    profile = tmp_path / 'profile-1'
    profile.mkdir()
    (profile / 'session.json').write_text(contents)
    (profile / 'chrome.json').write_text('[]')
    with open_stub(keep_profile=profile) as session:
        assert session.page.url == LISTING_URL


def test_shutdown_failure_does_not_break_five_later_captures(tmp_path, monkeypatch):
    import auto24_service.browser_chromium as launcher
    from contextlib import contextmanager
    from auto24_service.browser import capture_listing

    drivers = []
    from patchright.sync_api import sync_playwright

    class Manager:
        def start(self):
            driver = sync_playwright().start()
            drivers.append(driver)
            return driver

    monkeypatch.setattr('patchright.sync_api.sync_playwright', Manager)
    original_cleanup = launcher._cleanup_groups

    cleanup_calls = 0

    def cleanup_then_timeout(*args):
        nonlocal cleanup_calls
        cleanup_calls += 1
        original_cleanup(*args)
        raise subprocess.TimeoutExpired('Xvfb', 5)

    @contextmanager
    def opener(url, **kwargs):
        with open_stub(profile_dir=tmp_path) as session:
            monkeypatch.setattr(launcher, '_cleanup_groups', cleanup_then_timeout)
            yield session

    try:
        capture_listing(LISTING_URL, solver=None, opener=opener, on_html=lambda html: False)
        assert cleanup_calls == 1
        monkeypatch.setattr(launcher, '_cleanup_groups', original_cleanup)
        for number in range(5):
            capture_listing(LISTING_URL, solver=None,
                            opener=lambda url, **kwargs: open_stub(profile_dir=tmp_path),
                            on_html=lambda html: False)
        assert not list(tmp_path.glob('a24-chromium-*'))
    finally:
        monkeypatch.setattr(launcher, '_cleanup_groups', original_cleanup)
        for driver in drivers:
            driver.stop()


@pytest.mark.parametrize('failure_stage', ['context_close', 'playwright_stop', 'cleanup_groups'])
def test_context_close_failure_preserves_capture_error(tmp_path, monkeypatch, failure_stage):
    from auto24_service.browser import capture_listing
    import auto24_service.browser_chromium as launcher
    from patchright.sync_api import sync_playwright

    drivers = []

    class Manager:
        def start(self):
            driver = sync_playwright().start()
            drivers.append(driver)
            return driver

    monkeypatch.setattr('patchright.sync_api.sync_playwright', Manager)

    @contextlib.contextmanager
    def opener(url, **kwargs):
        with open_stub(profile_dir=tmp_path) as session:
            if failure_stage == 'context_close':
                target, name = session.context, 'close'
            elif failure_stage == 'playwright_stop':
                target, name = drivers[-1], 'stop'
            else:
                target, name = launcher, '_cleanup_groups'
            original = getattr(target, name)

            def fail_cleanup(*args, **kwargs):
                original(*args, **kwargs)
                raise RuntimeError('shutdown failed')

            monkeypatch.setattr(target, name, fail_cleanup)
            raise CaptureError('extension_not_loaded')
            yield session

    with pytest.raises(CaptureError) as error:
        capture_listing(LISTING_URL, solver=None, opener=opener, on_html=lambda html: False)
    assert error.value.code == 'extension_not_loaded'
    assert not list(tmp_path.glob('a24-chromium-*'))
