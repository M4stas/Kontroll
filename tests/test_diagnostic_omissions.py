import json
import threading
import time
import httpx
import pytest
from auto24_service.diagnostics import SpanRecorder
from auto24_service.storage_client import StorageClient
from auto24_service.storage_api import RecordSpansRequest


def test_failed_writes_report_cumulative_omissions_on_daemon():
    counts = []
    caller = threading.get_ident()
    def omitted(count):
        assert threading.get_ident() != caller
        counts.append(count)
        return True
    recorder = SpanRecorder(lambda spans: False, job_id="job", attempt=1, on_omitted=omitted)
    with recorder.phase("parsing"):
        pass
    recorder.flush(.1)
    recorder.close()
    assert counts[-1] == recorder.omitted == 2


def test_blocked_omission_reporting_stays_within_flush_budget():
    release = threading.Event()
    recorder = SpanRecorder(lambda spans: False, job_id="job", attempt=1,
                            on_omitted=lambda count: release.wait(1))
    with recorder.phase("parsing"):
        pass
    start = time.monotonic()
    recorder.flush(.1)
    recorder.close()
    release.set()
    assert time.monotonic() - start < .15
    assert recorder.omitted == 2


def test_storage_client_sends_optional_cumulative_omission_count():
    requests = []
    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"updated": True})
    with StorageClient("http://storage.test", "key", transport=httpx.MockTransport(respond)) as client:
        assert client.record_spans("job", "lease", [], timeout=1, omitted=7)
    assert requests == [{"lease_token": "lease", "spans": [], "omitted": 7}]


def test_omission_request_defaults_zero_and_rejects_negative():
    assert RecordSpansRequest(lease_token="lease", spans=[]).omitted == 0
    with pytest.raises(ValueError):
        RecordSpansRequest(lease_token="lease", spans=[], omitted=-1)


def test_queue_drops_are_reported_before_flush_returns():
    release = threading.Event()
    entered = threading.Event()
    counts = []
    def write(spans):
        entered.set()
        release.wait(.1)
        return True
    recorder = SpanRecorder(write, job_id="job", attempt=1, max_pending=1,
                            on_omitted=lambda count: counts.append(count) or True)
    with recorder.phase("parsing"):
        assert entered.wait(.1)
        for _ in range(10):
            with recorder.phase("validation"):
                pass
    release.set()
    recorder.flush(.1)
    recorder.close()
    assert counts[-1] == recorder.omitted > 0


def test_route_persists_cumulative_omissions_idempotently(tmp_path):
    from test_storage_api import KEY, NOW, URL, request
    from auto24_service.store import JobStore
    from auto24_service.storage_api import create_storage_app
    with_store = JobStore(str(tmp_path / "jobs.db"), lambda: NOW, diagnostics_enabled=True)
    try:
        job = with_store.create(URL)
        claim = with_store.claim()
        app = create_storage_app(with_store, KEY)
        async def report(client):
            return await client.post(f"/internal/jobs/{job.job_id}/diagnostics",
                headers={"X-Internal-Key": KEY},
                json={"lease_token": claim.lease_token, "spans": [], "omitted": 3})
        assert request(app, report).json() == {"updated": True}
        assert request(app, report).json() == {"updated": True}
        assert with_store.diagnostics(job.job_id).omitted == 3
    finally:
        with_store.close()


def test_worker_closes_recorder_if_capture_is_interrupted(monkeypatch):
    from test_worker import FakeStorageClient, claimed_job, worker, parse_listing
    closed = []
    class Recorder:
        def __init__(self, *args, **kwargs): pass
        def close(self): closed.append(True)
    monkeypatch.setattr(worker, "SpanRecorder", Recorder)
    def interrupted(url, *, deadline, observer):
        raise KeyboardInterrupt
    with pytest.raises(KeyboardInterrupt):
        worker.run_once(FakeStorageClient(claimed_job()), interrupted, parse_listing,
                        diagnostics_enabled=True)
    assert closed == [True]


def _store(tmp_path):
    from datetime import datetime, timezone
    from auto24_service.store import JobStore
    return JobStore(str(tmp_path / "omitted.db"), lambda: datetime(2026, 10, 13, 12, tzinfo=timezone.utc),
                    diagnostics_enabled=True)


def test_complete_adds_final_omitted_count_once_per_attempt(tmp_path):
    store = _store(tmp_path)
    try:
        job = store.create("https://www.auto24.ee/soidukid/4344096")
        claim = store.claim()
        assert store.record_spans(job.job_id, claim.lease_token, [], omitted=2)
        assert store.complete(job.job_id, claim.lease_token, {}, [], diagnostic_omitted=5)
        assert store.diagnostics(job.job_id).omitted == 5
    finally:
        store.close()


def test_fail_adds_final_omitted_count(tmp_path):
    store = _store(tmp_path)
    try:
        job = store.create("https://www.auto24.ee/soidukid/4344096")
        claim = store.claim()
        assert store.fail(job.job_id, claim.lease_token, "listing_gone", "gone", False, diagnostic_omitted=3)
        assert store.diagnostics(job.job_id).omitted == 3
    finally:
        store.close()


def test_rejected_final_update_adds_no_omitted_count(tmp_path):
    store = _store(tmp_path)
    try:
        job = store.create("https://www.auto24.ee/soidukid/4344096")
        store.claim()
        assert not store.complete(job.job_id, "wrong", {}, [], diagnostic_omitted=4)
        assert store.diagnostics(job.job_id).omitted == 0
    finally:
        store.close()


def test_spans_dropped_at_flush_deadline_reach_the_final_update():
    from test_worker import FakeStorageClient, captured, claimed_job, FIXTURE, worker, parse_listing
    release = threading.Event()

    class SlowClient(FakeStorageClient):
        def record_spans(self, *args, timeout, omitted=0):
            release.wait(1)  # storage answers slower than the 100 ms flush budget
            return True

        def complete(self, *args, diagnostic_omitted=0, **kwargs):
            self.final_omitted = diagnostic_omitted
            return super().complete(*args, **kwargs)

    client = SlowClient(claimed_job())
    try:
        worker.run_once(client, lambda url, *, deadline, observer: captured(FIXTURE.read_text()), parse_listing, diagnostics_enabled=True)
    finally:
        release.set()
    assert client.completed
    assert client.final_omitted > 0


def test_storage_api_accepts_final_omitted_count():
    from auto24_service.storage_api import CompleteJobRequest, FailJobRequest
    assert FailJobRequest(lease_token="t", code="listing_gone", message="m", transient=False).diagnostic_omitted == 0
    with pytest.raises(ValueError):
        FailJobRequest(lease_token="t", code="listing_gone", message="m", transient=False, diagnostic_omitted=-1)
    assert "diagnostic_omitted" in CompleteJobRequest.model_fields
