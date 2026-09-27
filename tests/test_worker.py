from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto24_service.browser import CaptureError
from auto24_service.parser import parse_listing
from auto24_service.store import ClaimedJob, JobStore
import auto24_service.worker as worker


LISTING_URL = "https://www.auto24.ee/soidukid/4344096"
LEASE_TOKEN = "lease-token-1"
LEASE_UNTIL = datetime(2026, 9, 27, 12, 2, tzinfo=timezone.utc)
FIXTURE = Path(__file__).parent / "fixtures" / "auto24-passenger-car.html"


def claimed_job() -> ClaimedJob:
    return ClaimedJob(
        job_id="job-1",
        source_url=LISTING_URL,
        attempts=1,
        lease_token=LEASE_TOKEN,
        lease_until=LEASE_UNTIL,
    )


class FakeStorageClient:
    def __init__(self, claim):
        self.claimed = claim
        self.completed = []
        self.failed = []

    def claim(self):
        claim, self.claimed = self.claimed, None
        return claim

    def complete(self, job_id, lease_token, listing, warnings):
        self.completed.append((job_id, lease_token, listing, warnings))
        return True

    def fail(self, job_id, lease_token, code, message, transient):
        self.failed.append((job_id, lease_token, code, message, transient))
        return True


def test_run_once_parses_and_completes_claimed_job_with_lease_token():
    client = FakeStorageClient(claimed_job())

    processed = worker.run_once(
        client,
        lambda url: FIXTURE.read_text(encoding="utf-8"),
        parse_listing,
    )

    assert processed is True
    assert client.completed[0][0:2] == ("job-1", LEASE_TOKEN)
    assert client.completed[0][2]["listing_id"] == "4344096"
    assert client.completed[0][2]["title"] == "Skoda Enyaq 195kW"
    assert client.completed[0][3] == []
    assert client.failed == []


def test_run_once_returns_false_without_capturing_when_queue_is_empty():
    client = FakeStorageClient(None)

    processed = worker.run_once(
        client,
        lambda _url: (_ for _ in ()).throw(AssertionError("captured without a job")),
        parse_listing,
    )

    assert processed is False
    assert client.completed == []
    assert client.failed == []


def test_browser_timeout_is_recorded_as_retryable_temporary_failure():
    client = FakeStorageClient(claimed_job())

    def timeout(_url):
        raise CaptureError("temporary_failure")

    assert worker.run_once(client, timeout, parse_listing) is True
    assert client.completed == []
    assert client.failed[0][0:3] == ("job-1", LEASE_TOKEN, "temporary_failure")
    assert client.failed[0][4] is True


def test_parse_failure_is_recorded_as_terminal():
    client = FakeStorageClient(claimed_job())

    assert worker.run_once(client, lambda _url: "<main>not a listing</main>", parse_listing) is True
    assert client.completed == []
    assert client.failed[0][0:3] == ("job-1", LEASE_TOKEN, "parse_failed")
    assert client.failed[0][4] is False


def test_successful_worker_run_persists_snapshot_with_utc_parsed_at(tmp_path):
    parsed_at = datetime(2026, 9, 27, 12, 0, 15, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: parsed_at)
    try:
        created = store.create(LISTING_URL)

        class StoreBackedClient:
            def claim(self):
                return store.claim()

            def complete(self, job_id, lease_token, listing, warnings):
                return store.complete(job_id, lease_token, listing, warnings)

            def fail(self, job_id, lease_token, code, message, transient):
                return store.fail(job_id, lease_token, code, message, transient)

        assert worker.run_once(
            StoreBackedClient(),
            lambda _url: FIXTURE.read_text(encoding="utf-8"),
            parse_listing,
        ) is True

        saved = store.get(created.job_id)
        assert saved.status == "completed"
        assert saved.parsed_at == parsed_at
        assert saved.parsed_at.isoformat().replace("+00:00", "Z") == "2026-09-27T12:00:15Z"
        assert saved.listing["listing_id"] == "4344096"
    finally:
        store.close()


def test_run_forever_waits_two_seconds_after_an_empty_claim(monkeypatch):
    calls = []
    sleeps = []

    class StopLoop(Exception):
        pass

    def stop_after_one_empty_claim(*_args):
        calls.append(True)
        if len(calls) > 1:
            raise StopLoop
        return False

    monkeypatch.setattr(worker, "run_once", stop_after_one_empty_claim)
    monkeypatch.setattr(worker.time, "sleep", sleeps.append)

    with pytest.raises(StopLoop):
        worker.run_forever(object(), None, None)

    assert calls == [True, True]
    assert sleeps == [2]


def test_main_once_uses_configured_storage_client_and_closes_it(monkeypatch):
    observed = {}

    class Client:
        def __init__(self, base_url, internal_key):
            observed["config"] = (base_url, internal_key)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            observed["closed"] = True

    def process_once(client, capture_html, parser):
        observed["once"] = (client, capture_html, parser)
        return True

    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setattr(worker, "StorageClient", Client)
    monkeypatch.setattr(worker, "run_once", process_once)

    assert worker.main(["--once"]) == 0

    assert observed["config"] == ("http://127.0.0.1:8001", "private-key")
    assert observed["once"][1:] == (worker.capture_html, worker.parse_listing)
    assert observed["closed"] is True
