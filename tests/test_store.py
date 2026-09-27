from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest
import turso

from auto24_service.store import ClaimedJob, JobRecord, JobStore


URL = "https://www.auto24.ee/soidukid/1"
NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


class MutableClock:
    def __init__(self):
        self.value = NOW
        self._next_call = None

    def __call__(self):
        value = self.value
        if self._next_call is not None:
            entered, release = self._next_call
            self._next_call = None
            entered.set()
            if not release.wait(timeout=5):
                raise TimeoutError("clock gate was not released")
        return value

    def advance(self, **parts):
        self.value += timedelta(**parts)

    def hold_next_call(self, entered, release):
        self._next_call = entered, release


class ObservableLock:
    def __init__(self, entered):
        self._lock = threading.RLock()
        self._owner = None
        self._entered = entered

    def __enter__(self):
        thread_id = threading.get_ident()
        if self._owner is not None and self._owner != thread_id:
            self._entered.set()
        self._lock.acquire()
        self._owner = thread_id
        return self

    def __exit__(self, *_):
        self._owner = None
        self._lock.release()


def run_after_store_lock_wait(store, clock, operation, **advance):
    entered = threading.Event()
    release = threading.Event()
    clock.hold_next_call(entered, release)
    lock = ObservableLock(entered)
    store._lock = lock
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = None
        try:
            with lock:
                future = pool.submit(operation)
                assert entered.wait(timeout=5)
                clock.advance(**advance)
        finally:
            release.set()
        return future.result(timeout=5)


@pytest.fixture
def store_context(tmp_path):
    path = str(tmp_path / "jobs.db")
    clock = MutableClock()
    store = JobStore(path, clock)
    try:
        yield path, clock, store
    finally:
        store.close()


def test_new_job_is_queued_with_utc_submission_time(store_context):
    _, _, store = store_context

    job = store.create(URL)

    assert isinstance(job, JobRecord)
    assert job.source_url == URL
    assert job.status == "queued"
    assert job.submitted_at == NOW
    assert job.attempts == 0
    assert job.parsed_at is None
    assert job.listing is None
    assert store.get(job.job_id) == job
    assert store.get("missing-job") is None


def test_repeated_urls_get_distinct_jobs_claimed_once_in_submission_order(store_context):
    _, _, store = store_context
    first = store.create(URL)
    second = store.create(URL)

    assert first.job_id != second.job_id
    first_claim = store.claim()
    second_claim = store.claim()
    first_record = store.get(first.job_id)

    assert isinstance(first_claim, ClaimedJob)
    assert first_claim.job_id == first.job_id
    assert second_claim.job_id == second.job_id
    assert first_claim.lease_token != second_claim.lease_token
    assert first_record.started_at == NOW
    assert first_record.attempts == 1
    assert store.claim() is None


def test_concurrent_claims_on_one_connection_do_not_duplicate_a_lease(store_context):
    _, _, store = store_context
    job = store.create(URL)

    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: store.claim(), range(2)))

    granted = [claim for claim in claims if claim is not None]
    assert len(granted) == 1
    assert granted[0].job_id == job.job_id


def test_expired_leases_become_terminal_after_three_attempts(store_context):
    _, clock, store = store_context
    job = store.create(URL)
    previous_token = None

    for attempts in (1, 2, 3):
        claim = store.claim()
        assert claim.attempts == attempts
        assert claim.lease_until == clock() + timedelta(minutes=2)
        if previous_token is not None:
            assert claim.lease_token != previous_token
        previous_token = claim.lease_token
        clock.advance(minutes=2)

    assert store.claim() is None
    terminal = store.get(job.job_id)
    assert terminal.status == "failed"
    assert terminal.attempts == 3
    assert terminal.error_code == "temporary_failure"
    assert terminal.lease_token is None
    assert terminal.lease_until is None


def test_claim_lease_starts_after_waiting_for_serialized_store(store_context):
    _, clock, store = store_context
    job = store.create(URL)

    claim = run_after_store_lock_wait(store, clock, store.claim, minutes=3)

    assert claim.attempts == 1
    assert claim.lease_until == clock() + timedelta(minutes=2)
    assert store.get(job.job_id).lease_until == claim.lease_until


@pytest.mark.parametrize("mutation", ["complete", "fail"])
def test_mutation_rechecks_lease_after_waiting_for_store_lock(store_context, mutation):
    _, clock, store = store_context
    job = store.create(URL)
    claim = store.claim()
    clock.advance(minutes=1, seconds=59)

    if mutation == "complete":
        operation = lambda: store.complete(job.job_id, claim.lease_token, {"title": "A"}, [])
    else:
        operation = lambda: store.fail(
            job.job_id, claim.lease_token, "temporary_failure", "late", True
        )
    result = run_after_store_lock_wait(store, clock, operation, seconds=1)

    assert result is False
    current = store.get(job.job_id)
    assert current.status == "running"
    assert current.parsed_at is None
    assert current.listing is None


def test_completion_rejects_wrong_or_expired_lease_without_mutating_job(store_context):
    _, clock, store = store_context
    job = store.create(URL)
    claim = store.claim()

    assert store.complete(job.job_id, "wrong-token", {"title": "A"}, []) is False
    assert store.get(job.job_id).status == "running"
    clock.advance(minutes=2)
    assert store.complete(job.job_id, claim.lease_token, {"title": "A"}, []) is False

    current = store.get(job.job_id)
    assert current.status == "running"
    assert current.parsed_at is None
    assert current.listing is None


def test_transient_failures_retry_twice_then_become_terminal(store_context):
    _, clock, store = store_context
    job = store.create(URL)

    first = store.claim()
    assert store.fail(job.job_id, first.lease_token, "temporary_failure", "network", True)
    assert store.get(job.job_id).status == "queued"
    assert store.get(job.job_id).retry_at == NOW + timedelta(seconds=5)
    clock.advance(seconds=4)
    assert store.claim() is None
    clock.advance(seconds=1)

    second = store.claim()
    assert second.attempts == 2
    assert store.fail(job.job_id, second.lease_token, "temporary_failure", "network", True)
    assert store.get(job.job_id).retry_at == clock() + timedelta(seconds=30)
    clock.advance(seconds=30)

    third = store.claim()
    assert third.attempts == 3
    assert store.fail(job.job_id, third.lease_token, "temporary_failure", "network", True)

    terminal = store.get(job.job_id)
    assert terminal.status == "failed"
    assert terminal.attempts == 3
    assert terminal.error_code == "temporary_failure"
    assert terminal.error_message == "network"
    assert terminal.retry_at is None
    assert store.claim() is None


def test_permanent_failure_is_terminal_on_first_attempt(store_context):
    _, _, store = store_context
    job = store.create(URL)
    claim = store.claim()

    assert store.fail(job.job_id, claim.lease_token, "parse_failed", "bad page", False)

    failed = store.get(job.job_id)
    assert failed.status == "failed"
    assert failed.attempts == 1
    assert failed.error_code == "parse_failed"
    assert failed.error_message == "bad page"
    assert failed.retry_at is None
    assert store.claim() is None


def test_completion_commits_utc_snapshot_for_observers_and_reopened_store(store_context):
    path, clock, store = store_context
    observer = turso.connect(path)
    job = store.create(URL)
    claim = store.claim()
    listing = {"listing_id": "1", "title": "Example", "price": {"amount": 42}}

    assert observer.execute(
        "SELECT status, attempts, lease_token FROM jobs WHERE job_id = ?",
        (job.job_id,),
    ).fetchone() == ("running", 1, claim.lease_token)
    clock.advance(seconds=18)
    assert store.complete(job.job_id, claim.lease_token, listing, ["optional field missing"])

    committed = observer.execute(
        "SELECT status, parsed_at, listing_json, warnings_json, lease_token "
        "FROM jobs WHERE job_id = ?",
        (job.job_id,),
    ).fetchone()
    assert committed == (
        "completed",
        "2026-09-27T12:00:18.000000Z",
        '{"listing_id": "1", "title": "Example", "price": {"amount": 42}}',
        '["optional field missing"]',
        None,
    )

    observer.close()
    reopened = JobStore(path, clock)
    try:
        saved = reopened.get(job.job_id)
        assert saved.status == "completed"
        assert saved.parsed_at == clock()
        assert saved.listing == listing
        assert saved.warnings == ["optional field missing"]
    finally:
        reopened.close()
