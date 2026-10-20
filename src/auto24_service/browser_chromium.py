"""Isolated Chromium sessions with offline extension readiness and crash cleanup.

Website workers use Chromium's service_workers="block" policy. Extension worker
readiness is checked separately; no website-worker fallback is enabled.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time

from auto24_service.browser import CaptureError, ListingSession, _navigate
from auto24_service.guard import allowed_url, blocked_entry
from auto24_service.patchright_guard import verify_driver
from auto24_service.urls import InvalidListingURL, canonical_listing_url

# Local rule-only extension that blocks every WebSocket. See websocket_guard/.
WEBSOCKET_GUARD = Path(__file__).resolve().parent / 'websocket_guard'

QUIET_FLAGS = [
    '--disable-background-networking', '--disable-component-update',
    '--disable-domain-reliability', '--disable-sync', '--disable-breakpad',
    '--disable-client-side-phishing-detection', '--disable-default-apps',
    '--disable-features=AutofillServerCommunication,CertificateTransparencyComponentUpdater,MediaRouter,OptimizationHints,Translate,PreconnectToSearch',
    '--disable-field-trial-config', '--disable-background-mode',
    '--dns-prefetch-disable', '--no-first-run', '--no-default-browser-check',
    '--no-pings', '--metrics-recording-only', '--safebrowsing-disable-auto-update',
    '--force-webrtc-ip-handling-policy=default_public_interface_only',
]


def extension_id_for_path(path: Path) -> str:
    return ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(str(path).encode()).hexdigest()[:32])


def _write_marker(path: Path, value: dict) -> None:
    # Preserve the previous complete session identity if SIGKILL interrupts a write.
    pending = path.with_suffix('.tmp')
    pending.write_text(json.dumps(value))
    pending.replace(path)


def _identity(pid: int) -> dict | None:
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'start': stat[19], 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except (OSError, IndexError):
        return None


def _kill_group(identity: dict | None) -> None:
    if not identity or _identity(identity['pid']) != identity:
        return
    try:
        if os.getpgid(identity['pid']) == identity['pid']:
            os.killpg(identity['pid'], signal.SIGKILL)
    except ProcessLookupError:
        pass


def _session_groups(profile: Path, marker: dict) -> list[dict]:
    """Find launch groups even if the owner died before writing their PID file.

    Patchright creates Chromium as a group leader. Require the unique environment
    marker and the expected executable before recording a kernel process identity.
    """
    expected = {marker.get('chromium_executable'), marker.get('xvfb_executable')} - {None}
    token = f'AUTO24_CHROMIUM_PROFILE={profile}'.encode()
    groups = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            pid = int(proc.name)
            identity = _identity(pid)
            if identity is None:
                continue
            if os.getpgid(pid) != pid:
                continue
            if token not in (proc / 'environ').read_bytes().split(b'\0'):
                continue
            if str((proc / 'exe').resolve()) not in expected:
                continue
            if _identity(pid) == identity:
                groups.append(identity)
        except (OSError, ValueError):
            continue
    return groups


def _cleanup_groups(profile: Path, marker: dict) -> None:
    chrome_file = profile / 'chrome.json'
    if chrome_file.exists():
        try:
            _kill_group(json.loads(chrome_file.read_text()))
        except (OSError, ValueError, KeyError):
            pass
    for identity in _session_groups(profile, marker):
        _kill_group(identity)
    _kill_group(marker.get('xvfb'))


def sweep_leftovers(root: Path) -> int:
    """Remove only inactive marked profiles and their identity-matching groups."""
    removed = 0
    for profile in root.glob('a24-chromium-*'):
        if not profile.is_dir() or profile.is_symlink():
            continue
        try:
            with (profile / 'owner.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                marker = json.loads((profile / 'session.json').read_text())
                _cleanup_groups(profile, marker)
                shutil.rmtree(profile)
                removed += 1
        except (OSError, ValueError, KeyError):
            continue
    return removed


def _ready(context, extension_id: str, deadline: float | None) -> None:
    end = min(time.monotonic() + 5, deadline if deadline is not None else float('inf'))
    expected = f'chrome-extension://{extension_id}/background.js'
    try:
        worker = next((w for w in context.service_workers if w.url == expected), None)
        while worker is None:
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            candidate = context.wait_for_event('serviceworker', timeout=max(1, remaining * 1000))
            if candidate.url == expected:
                worker = candidate
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        # Worker.evaluate has no timeout parameter. Bound the asynchronous sqlite
        # operation inside the worker as well as worker discovery above.
        ready = worker.evaluate('''ms => Promise.race([
          Promise.resolve().then(() => self.queryPhash({imgtype:'33', name:'buses', phash:'0'})).then(() => true),
          new Promise((_, reject) => setTimeout(() => reject(Error('readiness timeout')), ms))
        ])''', max(1, remaining * 1000))
        if ready is not True:
            raise RuntimeError('probe failed')
    except Exception as exc:
        raise CaptureError('extension_not_loaded') from exc


def _websocket_guard_active(page) -> None:
    """Prove the guard rule is enforced before any website loads.

    A file Chromium leaves behind only shows the rules were indexed. Open a
    socket to an in-process loopback listener and require Chromium to refuse
    it without a TCP accept.
    """
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        result = page.evaluate('''url => new Promise(resolve => {
          const socket = new WebSocket(url);
          socket.onerror = () => resolve('refused');
          socket.onopen = () => { socket.close(); resolve('open'); };
          setTimeout(() => resolve('timeout'), 2000);
        })''', f'ws://127.0.0.1:{listener.getsockname()[1]}/', isolated_context=False)
        contacted = bool(select.select([listener], [], [], 0)[0])
    except Exception as exc:
        raise CaptureError('browser_launch') from exc
    finally:
        listener.close()
    if result != 'refused' or contacted:
        raise CaptureError('browser_launch')


@contextmanager
def open_chromium_listing(url, *, setup=None, profile_dir=None, deadline=None, extension_dir: Path | None = None, headless: bool | None = None):
    """Open one guarded listing using a disposable persistent profile."""
    try:
        canonical = canonical_listing_url(url)
    except InvalidListingURL as exc:
        raise CaptureError('access_blocked') from exc
    try:
        verify_driver()
    except (OSError, ValueError, ImportError) as exc:
        raise CaptureError('browser_launch') from exc
    # Chromium skips a missing --load-extension path with a warning only.
    if not all((WEBSOCKET_GUARD / name).is_file() for name in ('manifest.json', 'rules.json')):
        raise CaptureError('browser_launch')
    extension_dir = Path(extension_dir or os.environ.get('CAPTCHARAPTOR_EXTENSION_DIR', '/opt/captcharaptor-extension')).resolve()
    extension_id = extension_id_for_path(extension_dir)
    if headless is None:
        headless = os.environ.get('CHROMIUM_HEADLESS', 'false').lower() == 'true'
    root = Path(profile_dir or tempfile.gettempdir())
    root.mkdir(parents=True, exist_ok=True)
    sweep_leftovers(root)
    profile = Path(tempfile.mkdtemp(prefix='a24-chromium-', dir=root))
    lock = (profile / 'owner.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    context = playwright = xvfb = None
    executable = os.environ.get('CHROMIUM_EXECUTABLE', '/opt/ungoogled-chromium/chrome')
    marker = {'display': None, 'xvfb': None,
              'chromium_executable': str(Path(executable).resolve()),
              'xvfb_executable': str(Path(shutil.which('Xvfb') or '/missing/Xvfb').resolve())}
    _write_marker(profile / 'session.json', marker)
    try:
        env = dict(os.environ, AUTO24_CHROMIUM_PROFILE=str(profile))
        if not headless:
            read_fd, write_fd = os.pipe()
            try:
                xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-nolisten', 'tcp', '-screen', '0', '1366x768x24'], pass_fds=(write_fd,), env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                marker['xvfb'] = _identity(xvfb.pid)
                _write_marker(profile / 'session.json', marker)
                os.close(write_fd); write_fd = -1
                wait = min(5, max(0, deadline - time.monotonic())) if deadline else 5
                if not select.select([read_fd], [], [], wait)[0]:
                    raise CaptureError('browser_launch')
                display = os.read(read_fd, 64).decode().strip()
                if not display.isdigit():
                    raise CaptureError('browser_launch')
                env['DISPLAY'] = ':' + display
                marker['display'] = env['DISPLAY']
                _write_marker(profile / 'session.json', marker)
            finally:
                os.close(read_fd)
                if write_fd >= 0: os.close(write_fd)
        # Chromium writes indexed rules beside an unpacked extension, so give
        # each session a private copy of the read-only packaged guard.
        guard = profile / 'websocket-guard'
        # Chromium splits extension lists on commas.
        if ',' in str(guard) or ',' in str(extension_dir):
            raise CaptureError('browser_launch')
        try:
            shutil.copytree(WEBSOCKET_GUARD, guard)
        except OSError as exc:
            raise CaptureError('browser_launch') from exc
        from patchright.sync_api import sync_playwright
        playwright = sync_playwright().start()
        remaining = max(1, (deadline - time.monotonic()) * 1000) if deadline else 30000
        try:
            context = playwright.chromium.launch_persistent_context(str(profile), executable_path=executable, headless=headless, service_workers='block', env=env, timeout=min(30000, remaining), args=[f'--load-extension={extension_dir},{guard}', f'--disable-extensions-except={extension_dir},{guard}', *QUIET_FLAGS, *(['--headless=new'] if headless else [])])
        except Exception as exc:
            raise CaptureError('browser_launch') from exc
        groups = [identity for identity in _session_groups(profile, marker) if identity != marker['xvfb']]
        if len(groups) != 1:
            raise CaptureError('browser_launch')
        _write_marker(profile / 'chrome.json', groups[0])
        _ready(context, extension_id, deadline)
        page = context.pages[0] if context.pages else context.new_page()
        _websocket_guard_active(page)
        blocked = []
        # HTTP routing does not see WebSocket handshakes. The guard extension's
        # rule makes Chromium refuse every WS/WSS socket before any network
        # contact, in pages, frames and workers. Record page sockets here.
        def record_websocket(socket):
            entry = blocked_entry(socket.url)
            if entry not in blocked:
                blocked.append(entry)

        def watch_websockets(page):
            page.on('websocket', record_websocket)

        context.on('page', watch_websockets)
        for existing in context.pages:
            watch_websockets(existing)
        session = ListingSession(page=page, context=context, blocked=blocked, extension_loaded=True)
        state = {'blocked_main_frame': False}
        if setup is not None:
            setup(context)
        _navigate(session, canonical, state, deadline=deadline, allowed_url=lambda url, **kw: allowed_url(url, extension_id=extension_id, **kw), observe_redirects=False)
        yield session
    finally:
        if context is not None:
            try: context.close()
            except Exception: pass
        _cleanup_groups(profile, marker)
        if xvfb is not None:
            xvfb.wait(timeout=5)
        if playwright is not None:
            try: playwright.stop()
            except Exception: pass
        shutil.rmtree(profile, ignore_errors=True)
        lock.close()


def shared_page_opener(session, *, extension_dir: Path | None = None):
    """Opener that shows each listing in a new page of an already open session.

    The session's context-level route guard covers every page of that context
    and `open_chromium_listing` watches new pages for WebSockets, so no second
    route is added. Redirects and status checks use the same `_navigate`.
    """
    extension_dir = Path(extension_dir or os.environ.get('CAPTCHARAPTOR_EXTENSION_DIR', '/opt/captcharaptor-extension')).resolve()
    extension_id = extension_id_for_path(extension_dir)

    @contextmanager
    def opener(url, *, profile_dir=None, deadline=None):
        try:
            canonical = canonical_listing_url(url)
        except InvalidListingURL as exc:
            raise CaptureError('access_blocked') from exc
        page = session.context.new_page()
        child = ListingSession(page=page, context=session.context, blocked=session.blocked, extension_loaded=session.extension_loaded)
        seen = len(session.blocked)
        try:
            try:
                _navigate(child, canonical, {'blocked_main_frame': False}, deadline=deadline,
                          allowed_url=lambda target, **kw: allowed_url(target, extension_id=extension_id, **kw),
                          observe_redirects=False, install_guard=False)
            except CaptureError as exc:
                # The shared guard aborted the request; this page has no state of its own to say so.
                if exc.code == 'temporary_failure' and len(session.blocked) > seen:
                    raise CaptureError('access_blocked') from exc
                raise
            yield child
        finally:
            try: page.close()
            except Exception: pass

    # Pages of a shared session belong to the thread that drives its Playwright, so a
    # retry has to run on that thread instead of one of its own.
    opener.same_thread = True
    return opener
