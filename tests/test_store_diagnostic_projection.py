from datetime import datetime, timedelta, timezone

import pytest

from auto24_service.contracts import CaptureSpan
from auto24_service.store import JobStore


@pytest.mark.parametrize("transition", ["expired", "reclaimed", "completed", "failed", "retry"])
def test_stale_running_span_projects_incomplete_without_changing_storage(tmp_path, transition):
    now = datetime(2026, 10, 15, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: now, diagnostics_enabled=True)
    try:
        job = store.create("https://www.auto24.ee/soidukid/1")
        claim = store.claim()
        span = CaptureSpan(span_id="running", attempt=1, phase="navigation",
                           state="running", started_at=now)
        assert store.record_spans(job.job_id, claim.lease_token, [span])
        assert next(s for s in store.diagnostics(job.job_id).spans if s.span_id == "running") == span
        if transition in ("expired", "reclaimed"):
            now += timedelta(minutes=2)
            if transition == "reclaimed":
                second = store.claim()
                assert store.record_spans(job.job_id, second.lease_token, [
                    span.model_copy(update={"span_id": "active", "attempt": 2})])
        elif transition == "completed":
            assert store.complete(job.job_id, claim.lease_token, {}, [])
        else:
            assert store.fail(job.job_id, claim.lease_token, "temporary_failure", "network",
                              transition == "retry")
        result = store.diagnostics(job.job_id)
        projected = next(s for s in result.spans if s.span_id == "running")
        assert projected.state == "incomplete"
        assert projected.error_code == "collection_incomplete"
        assert projected.completed_at is None
        assert projected.duration_ms is None
        assert store._db.execute("SELECT state, error_code FROM diagnostic_spans WHERE span_id = 'running'").fetchone() == ("running", None)
        if transition == "reclaimed":
            assert next(s for s in result.spans if s.span_id == "active").state == "running"
        # Disabling diagnostics preserves the previous read behavior, too.
        store._diagnostics_enabled = False
        assert next(s for s in store.diagnostics(job.job_id).spans if s.span_id == "running") == span
    finally:
        store.close()


def test_worker_omissions_are_cumulative_idempotent_and_lease_checked(tmp_path):
    now = datetime(2026, 10, 15, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: now, diagnostics_enabled=True)
    try:
        job = store.create("https://www.auto24.ee/soidukid/1")
        claim = store.claim()
        assert store.record_spans(job.job_id, claim.lease_token, [], omitted=3)
        assert store.record_spans(job.job_id, claim.lease_token, [], omitted=3)
        assert store.record_spans(job.job_id, claim.lease_token, [], omitted=1)
        assert store.record_spans(job.job_id, claim.lease_token, [], omitted=5)
        assert store.diagnostics(job.job_id).omitted == 5
        now += timedelta(minutes=2)
        assert not store.record_spans(job.job_id, claim.lease_token, [], omitted=10)
        second = store.claim()
        assert not store.record_spans(job.job_id, claim.lease_token, [], omitted=10)
        assert store.record_spans(job.job_id, second.lease_token, [], omitted=2)
        assert store.diagnostics(job.job_id).omitted == 7
        assert store.complete(job.job_id, second.lease_token, {}, [])
        assert not store.record_spans(job.job_id, second.lease_token, [], omitted=10)
        store._diagnostics_enabled = False
        assert not store.record_spans(job.job_id, second.lease_token, [], omitted=100)
        assert store.diagnostics(job.job_id).omitted == 7
    finally:
        store.close()
