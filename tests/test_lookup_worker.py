from datetime import datetime, timedelta, timezone
import importlib
import logging
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest


class LookupClient:
    def __init__(self, claims):
        self.claims = iter(claims)
        self.finished = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def claim(self):
        pytest.fail("lookup worker must never claim extraction jobs")

    def claim_background_check(self):
        claim = next(self.claims)
        if isinstance(claim, Exception):
            raise claim
        return claim

    def finish_background_check(self, job_id, token, finish):
        self.finished.append((job_id, token, finish))
        return True


def setup_worker(monkeypatch, tmp_path, claims):
    module = importlib.import_module("auto24_service.lookup_worker")
    client = LookupClient(claims)
    monkeypatch.setenv("STORAGE_URL", "http://storage:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")
    monkeypatch.setenv("BACKGROUND_CHECK_DIR", str(tmp_path))
    def storage(url, key):
        assert (url, key) == ("http://storage:8001", "test-key")
        return client
    monkeypatch.setattr(module, "StorageClient", storage)
    return module, client


def claim():
    return SimpleNamespace(job_id="job-1", lease_token="token", search_kind="reg_number",
                           value="123ABC", deadline=datetime.now(timezone.utc) + timedelta(seconds=200))


def test_lookup_worker_claims_lookups_and_never_jobs(monkeypatch, tmp_path):
    module, client = setup_worker(monkeypatch, tmp_path, [claim()])
    from auto24_service.guard import MNT
    from auto24_service.mnt_lookup import LookupOutcome
    def lookup(kind, value, deadline, *, opener):
        assert (kind, value) == ("reg_number", "123ABC")
        assert deadline > 0
        assert opener.func is module.open_invisible_session
        assert opener.keywords == {"site": MNT}
        return LookupOutcome(status="fetched", searched_by="reg_number", pdf=b"%PDF-test")
    monkeypatch.setattr(module, "lookup_background_check", lookup)
    assert module.main(["--once"]) == 0
    assert client.finished[0][:2] == ("job-1", "token")
    assert Path(client.finished[0][2].pdf_path).read_bytes() == b"%PDF-test"
    assert Path(client.finished[0][2].pdf_path).parent == tmp_path


def test_lookup_worker_logs_engine_invisible(monkeypatch, tmp_path, caplog):
    module, client = setup_worker(monkeypatch, tmp_path, [claim()])
    from auto24_service.mnt_lookup import LookupOutcome
    monkeypatch.setattr(module, "lookup_background_check", lambda *a, **kw: LookupOutcome(status="not_found", searched_by="reg_number"))
    with caplog.at_level(logging.INFO):
        assert module.main(["--once"]) == 0
    assert "background_check=not_found engine=invisible" in caplog.text
    assert "123ABC" not in caplog.text


def test_lookup_worker_survives_a_failing_claim(monkeypatch, tmp_path):
    module, client = setup_worker(monkeypatch, tmp_path, [RuntimeError("offline"), None, claim()])
    sleeps = []
    class StopLoop(Exception):
        pass
    def sleep(seconds):
        sleeps.append(seconds)
    def lookup(*args, **kwargs):
        raise StopLoop
    # Stop after the successful claim is finished; ordinary lookup errors become unavailable.
    def finish(*args):
        raise StopLoop
    monkeypatch.setattr(module.time, "sleep", sleep)
    monkeypatch.setattr(module, "lookup_background_check", lookup)
    monkeypatch.setattr(client, "finish_background_check", finish)
    with pytest.raises(StopLoop):
        module.main([])
    assert sleeps == [1, 1]


@pytest.mark.parametrize("missing", ["STORAGE_URL", "INTERNAL_API_KEY"])
def test_lookup_worker_requires_credentials(monkeypatch, missing):
    module = importlib.import_module("auto24_service.lookup_worker")
    monkeypatch.setenv("STORAGE_URL", "http://storage:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")
    monkeypatch.delenv(missing)
    with pytest.raises(SystemExit) as exc:
        module.main(["--once"])
    assert exc.value.code == 2


def test_lookup_worker_imports_in_the_invisible_image():
    code = '''
import importlib.abc
import sys
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'camoufox', 'patchright', 'playwright', 'bs4', 'numpy', 'PIL', 'onnxruntime', 'pyturso', 'turso'}:
            raise ImportError('blocked dependency: ' + fullname)
sys.meta_path.insert(0, Block())
import auto24_service.lookup_worker
assert 'auto24_service.worker' not in sys.modules
'''
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
