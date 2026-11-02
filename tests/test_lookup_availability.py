from datetime import datetime, timedelta, timezone

import pytest

from auto24_service.store import JobStore


def pending(store):
    job = store.create('https://www.auto24.ee/soidukid/1')
    claim = store.claim()
    store.complete(job.job_id, claim.lease_token, {
        'source_url': job.source_url, 'listing_id': '1', 'title': 'Example',
        'equipment': {}, 'technical_specs': {}, 'other_fields': {}, 'photo_urls': [],
        'registration': {'reg_number_status': 'listed_in_full', 'reg_number': ''},
    }, [])
    store.request_background_check(job.job_id)
    return job.job_id


@pytest.fixture
def clock_store(tmp_path):
    clock = [datetime(2026, 11, 1, tzinfo=timezone.utc)]
    store = JobStore(str(tmp_path / 'jobs.db'), lambda: clock[0])
    yield clock, store
    store.close()


def test_no_worker_becomes_unavailable_after_grace(clock_store):
    clock, store = clock_store
    job = pending(store)
    clock[0] += timedelta(seconds=19)
    assert store.background_check(job).status == 'pending'
    clock[0] += timedelta(seconds=2)
    assert store.background_check(job).status == 'unavailable'
    assert store.background_check(job).reason == 'browser_crash'
    store.lookup_worker_heartbeat()
    assert store.claim_background_check() is None
    assert store.background_check(job).reason == 'browser_crash'


def test_busy_live_worker_keeps_full_deadline(clock_store):
    clock, store = clock_store
    job = pending(store)
    for _ in range(47):
        clock[0] += timedelta(seconds=5)
        store.lookup_worker_heartbeat()
        assert store.background_check(job).status == 'pending'
    clock[0] += timedelta(seconds=5)
    assert store.background_check(job).reason == 'timeout'


def test_worker_starting_during_grace_can_claim(clock_store):
    clock, store = clock_store
    job = pending(store)
    clock[0] += timedelta(seconds=19)
    store.lookup_worker_heartbeat()
    assert store.claim_background_check().job_id == job
    clock[0] += timedelta(seconds=21)
    assert store.background_check(job).status == 'pending'
    clock[0] += timedelta(seconds=200)
    assert store.background_check(job).reason == 'timeout'


def test_stale_heartbeat_does_not_keep_unclaimed_job_pending(clock_store):
    clock, store = clock_store
    store.lookup_worker_heartbeat()
    job = pending(store)
    clock[0] += timedelta(seconds=21)
    assert store.background_check(job).reason == 'browser_crash'


def test_unavailable_state_is_persisted(clock_store):
    clock, store = clock_store
    job = pending(store)
    clock[0] += timedelta(seconds=21)
    store.background_check(job)
    assert store._db.execute(
        'SELECT status, reason FROM background_checks WHERE job_id = ?', (job,)
    ).fetchone() == ('unavailable', 'browser_crash')
