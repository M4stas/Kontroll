"""Offline real Chromium launcher checks; requires the pinned Chromium image."""
import concurrent.futures
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
