"""Smoke test: the real CaptchaRaptor extension against the offline fake site.

Requires the pinned Chromium image with the extension built into
/opt/captcharaptor-extension. All values are fake and nothing leaves the host.

Extension loads are observed with `context.on('requestfinished')` in the test, with
a 2xx response status. That event does not fire for aborted or blocked requests,
so a finished load substitutes for a guard allow log, which does not exist for
chrome-extension:// loads. Production code is unchanged.

db/captcha.sqlite was not observed as a completed load by the probes tried. The
worker fetches it once at start, before the test can listen, and the probes ran
only after start: `requestfinished` and the worker's
`performance.getEntriesByType('resource')` recorded nothing for a fresh in-worker
fetch of the file (status 200). The startup fetch itself was not probed. The test
instead calls `self.queryPhash` in the worker, which awaits that database, and a
second test shows the real extension's `queryPhash` fails when the file is
corrupt, so a reply is evidence the file was fetched and opened.

Fake page changes made for the real extension (tests/fakesite/pages/bframe.html):
- The challenge root and target carry the classes `rc-imageselect` and
  `rc-imageselect-target`, as Google's frame does. The extension finds the
  challenge by those classes, not by id.
- The tile click handler no longer reads `event.currentTarget`. The extension
  replays clicks through synthetic events that were never dispatched, so
  currentTarget is null there; Google's frame does not rely on it.

Scenario choice, not a page change: the real grid model has no cars class, so
the 4x4 test asks for crosswalks.
"""
import os
import shutil
import time
from pathlib import Path

import pytest

if not Path(os.environ.get('CHROMIUM_EXECUTABLE', '/missing')).is_file():
    pytest.skip('Chromium image only', allow_module_level=True)

from auto24_service.browser import CaptureError
from auto24_service.browser_chromium import extension_id_for_path, open_chromium_listing
from tests.fakesite import LISTING_URL, Scenario, install_fake_site

REAL = Path('/opt/captcharaptor-extension')
WINDOW_S = 30
ASSETS = (
    'models/type.onnx',
    'models/grid.onnx',
    'libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
)


# The real grid model has no cars class, so the 4x4 challenge asks for crosswalks.
GRID_4X4 = Scenario(grid='4x4', instruction='Select all squares with crosswalks',
                    label_id='/m/014xcs', label_name='Crosswalk')


def solve(scenario, *, until):
    """Click the trigger and wait up to 30 s for `until(log)`; return (log, loads, blocked, sqlite_ok)."""
    logs, loads = [], []

    def setup(context):
        logs.append(install_fake_site(context, scenario))
        def finished(request):
            response = request.response()
            if response is not None and 200 <= response.status < 300:
                loads.append(request.url)

        context.on('requestfinished', finished)

    with open_chromium_listing(LISTING_URL, setup=setup, extension_dir=REAL) as session:
        session.page.click('.service-trigger[data-action="uv_regnr"]')
        end = time.monotonic() + WINDOW_S
        while time.monotonic() < end and not until(logs[0]):
            session.page.wait_for_timeout(250)
        # The worker fetches db/captcha.sqlite once, when it starts, before the test can
        # listen. queryPhash awaits that database, so a reply proves the file loaded.
        url = f'chrome-extension://{extension_id_for_path(REAL)}/background.js'
        worker = next((w for w in session.context.service_workers if w.url == url), None)
        if worker is None:
            worker = session.context.wait_for_event(
                'serviceworker', predicate=lambda w: w.url == url, timeout=5000)
        sqlite_ok = worker.evaluate(
            "() => self.queryPhash({imgtype: '33', name: 'buses', phash: '0'}).then(() => true)")
        return logs[0], list(loads), list(session.blocked), sqlite_ok


def answered(log):
    return log.verifies >= 1 and any('/recaptcha/api2/userverify' in url for url in log.requests)


def check_answer(scenario):
    log, _, _, _ = solve(scenario, until=answered)
    assert any('/recaptcha/api2/anchor' in url for url in log.requests)  # checkbox frame loaded
    assert any('/recaptcha/api2/bframe' in url for url in log.requests)  # challenge opened
    assert log.verifies >= 1  # userverify reached the fake site
    assert any(tiles for tiles in log.clicked_tiles)  # at least one tile was clicked


def test_real_extension_submits_a_3x3_answer():
    check_answer(Scenario())


def test_real_extension_submits_a_4x4_answer():
    check_answer(GRID_4X4)


def test_real_extension_loads_models_wasm_and_sqlite():
    # The type model serves 3x3 challenges and the grid model serves 4x4 ones.
    loads, sqlite_ok = [], True
    for scenario in (Scenario(), GRID_4X4):
        _, seen, blocked, ok = solve(scenario, until=answered)
        loads += seen
        sqlite_ok = sqlite_ok and ok
        # Only the fake listing's own photos (img-bcg.eu) are refused. The extension, Google
        # and WebSockets are not.
        assert sorted(blocked) == ['img-bcg.eu/related/', 'img-bcg.eu/thumb/'], blocked
    base = f'chrome-extension://{extension_id_for_path(REAL)}/'
    for asset in ASSETS:
        assert any(url.startswith(base + asset) for url in loads), asset
    assert sqlite_ok is True


def test_real_extension_without_a_usable_database_is_not_ready(tmp_path):
    broken = tmp_path / 'extension'
    shutil.copytree(REAL, broken)
    (broken / 'db' / 'captcha.sqlite').write_bytes(b'not a database')
    with pytest.raises(CaptureError) as caught:
        with open_chromium_listing(LISTING_URL, extension_dir=broken):
            pass
    assert caught.value.code == 'extension_not_loaded'
