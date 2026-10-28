"""Give each pytest-xdist worker its own temp dir.

Chromium sessions and the worker keep profiles under tempfile.gettempdir() and
sweep leftovers there, so parallel workers sharing /tmp would see each other's
profiles. TMPDIR is set too, for the subprocesses some tests start.
"""
import os
import shutil
import tempfile

_worker_tmp = None


def pytest_configure(config):
    global _worker_tmp
    worker = os.environ.get('PYTEST_XDIST_WORKER')
    if worker:
        _worker_tmp = tempfile.mkdtemp(prefix=f'pytest-{worker}-')
        tempfile.tempdir = _worker_tmp
        os.environ['TMPDIR'] = _worker_tmp


def pytest_unconfigure(config):
    if _worker_tmp:
        shutil.rmtree(_worker_tmp, ignore_errors=True)
