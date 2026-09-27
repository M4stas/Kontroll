from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

import pytest
import turso

from auto24_service.store import ClaimedJob, JobRecord, JobStore


URL = "https://www.auto24.ee/soidukid/1"
NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


class MutableClock:
    def __init__(self):
        self.value = NOW

    def __call__(self):
        return self.value

    def advance(self, **parts):
        self.value += timedelta(**parts)


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

    assert isinstance(first_claim, ClaimedJob)
    assert first_claim.job_id == first.job_id
    assert second_claim.job_id == second.job_id
    assert first_claim.lease_token != second_claim.lease_token
    assert store.claim() is None


def test_claim_sets_attempt_and_two_minute_lease(store_context):
    _, _, store = store_context
    job = store.create(URL)

    claim = store.claim()
    current = store.get(job.job_id)

    assert claim.attempts == 1
    assert claim.lease_until == NOW + timedelta(minutes=2)
    assert current.status == "running"
    assert current.started_at == NOW
    assert current.lease_token == claim.lease_token
    assert current.lease_until == claim.lease_until


def test_concurrent_claims_on_one_connection_do_not_duplicate_a_lease(store_context):
    _, _, store = store_context
    job = store.create(URL)

    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: store.claim(), range(2)))

    granted = [claim for claim in claims if claim is not None]
    assert len(granted) == 1
    assert granted[0].job_id == job.job_id


def test_expired_lease_can_be_claimed_again_with_a_new_token(store_context):
    _, clock, store = store_context
    job = store.create(URL)
    first = store.claim()
    clock.advance(minutes=2)

    second = store.claim()

    assert second.job_id == job.job_id
    assert second.attempts == 2
    assert second.lease_token != first.lease_token
    assert second.lease_until == clock() + timedelta(minutes=2)


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
