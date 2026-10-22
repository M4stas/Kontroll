from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest
import turso

from auto24_service.contracts import Registration
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


DIAGNOSTICS = {"attempts": [{"attempt": 1, "outcome": "no_captcha_needed", "duration_ms": 5}]}


def test_store_persists_reveal_diagnostics_across_reopen(store_context):
    path, clock, store = store_context
    job = store.create(URL)
    claim = store.claim()
    assert store.complete(job.job_id, claim.lease_token, {"listing_id": "1"}, [], DIAGNOSTICS)
    other = store.create(URL)
    other_claim = store.claim()
    assert store.complete(other.job_id, other_claim.lease_token, {"listing_id": "2"}, [])
    assert store.get(job.job_id).reveal_diagnostics == DIAGNOSTICS

    store.close()
    reopened = JobStore(path, clock)
    try:
        assert reopened.get(job.job_id).reveal_diagnostics == DIAGNOSTICS
        assert reopened.get(other.job_id).reveal_diagnostics is None
    finally:
        reopened.close()


def test_rejected_completion_does_not_store_reveal_diagnostics(store_context):
    path, _clock, store = store_context
    job = store.create(URL)
    store.claim()
    assert not store.complete(job.job_id, "wrong", {"listing_id": "1"}, [], DIAGNOSTICS)
    observer = turso.connect(path)
    try:
        assert observer.execute("SELECT COUNT(*) FROM job_reveals").fetchone() == (0,)
    finally:
        observer.close()


def test_store_opens_a_database_created_before_job_reveals_existed(tmp_path):
    path = str(tmp_path / "old.db")
    old = turso.connect(path)
    old.execute(
        """
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, status TEXT NOT NULL,
          submitted_at TEXT NOT NULL, started_at TEXT, parsed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
          retry_at TEXT, listing_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
          error_code TEXT, error_message TEXT
        )
        """
    )
    old.execute(
        "INSERT INTO jobs (job_id, source_url, status, submitted_at, parsed_at, listing_json) "
        "VALUES ('old-1', ?, 'completed', '2026-09-27T11:00:00.000000Z', "
        "'2026-09-27T11:00:05.000000Z', '{\"listing_id\": \"0\"}')",
        (URL,),
    )
    old.commit()
    old.close()

    store = JobStore(path, MutableClock())
    try:
        assert store.get("old-1").reveal_diagnostics is None
        job = store.create(URL)
        claim = store.claim()
        assert store.complete(job.job_id, claim.lease_token, {"listing_id": "1"}, [], DIAGNOSTICS)
        assert store.get(job.job_id).reveal_diagnostics == DIAGNOSTICS
    finally:
        store.close()


@pytest.fixture
def diagnostic_store(tmp_path):
    clock = MutableClock()
    store = JobStore(str(tmp_path / "diagnostics.db"), clock, diagnostics_enabled=True)
    try:
        yield clock, store
    finally:
        store.close()


def timing_span(span_id="worker", attempt=1, **changes):
    from auto24_service.contracts import CaptureSpan
    return CaptureSpan(**dict(dict(span_id=span_id, attempt=attempt, phase="parsing",
        state="running", started_at=NOW, completed_at=None, duration_ms=None,
        error_code=None), **changes))


def test_reopening_jobs_only_database_adds_spans_and_keeps_jobs(tmp_path):
    path = str(tmp_path / "old.db")
    db = turso.connect(path)
    db.execute("""CREATE TABLE jobs (job_id TEXT PRIMARY KEY, source_url TEXT NOT NULL,
        status TEXT NOT NULL, submitted_at TEXT NOT NULL, started_at TEXT, parsed_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
        retry_at TEXT, listing_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT, error_message TEXT)""")
    db.execute("INSERT INTO jobs (job_id,source_url,status,submitted_at) VALUES ('old',?,'queued',?)", (URL,NOW.isoformat()))
    before = db.execute("SELECT * FROM jobs").fetchone()
    db.commit()
    db.close()
    store = JobStore(path, MutableClock())
    try:
        assert store.get("old").source_url == URL
        assert store._db.execute("SELECT * FROM jobs").fetchone()[:-3] == before
        assert store.diagnostics("old").spans == []
        assert store.diagnostics("missing") is None
    finally:
        store.close()


def test_first_claim_records_queue_wait_from_submission(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    clock.advance(seconds=3)
    store.claim()
    span, = store.diagnostics(job.job_id).spans
    assert (span.phase,span.attempt,span.state,span.duration_ms) == ("queue_wait",1,"complete",3000)


def test_transient_failure_records_retry_wait_and_next_queue_wait(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    claim = store.claim()
    clock.advance(seconds=10)
    store.fail(job.job_id, claim.lease_token, "temporary_failure", "network", True)
    clock.advance(seconds=10)
    store.claim()
    spans = store.diagnostics(job.job_id).spans
    retry, = [s for s in spans if s.phase == "retry_wait"]
    queued, = [s for s in spans if s.attempt == 2]
    assert (retry.attempt,retry.duration_ms) == (1,5000)
    assert queued.started_at == NOW + timedelta(seconds=15)
    assert queued.duration_ms == 5000


def test_reclaim_after_lease_expiry_measures_wait_from_lease_end(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    first = store.claim()
    clock.advance(minutes=2, seconds=4)
    store.claim()
    span, = [s for s in store.diagnostics(job.job_id).spans if s.attempt == 2]
    assert span.started_at == first.lease_until
    assert span.duration_ms == 4000


def test_record_spans_requires_active_lease(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    first = store.claim()
    assert not store.record_spans(job.job_id,"wrong",[timing_span()])
    clock.advance(minutes=2)
    assert not store.record_spans(job.job_id,first.lease_token,[timing_span()])
    second = store.claim()
    assert not store.record_spans(job.job_id,first.lease_token,[timing_span()])
    assert not store.record_spans(job.job_id,second.lease_token,[timing_span()])
    assert store.complete(job.job_id,second.lease_token,{},[])
    assert not store.record_spans(job.job_id,second.lease_token,[timing_span(attempt=2)])
    assert all(s.phase != "parsing" for s in store.diagnostics(job.job_id).spans)


def test_record_spans_upserts_by_span_id_and_keeps_other_attempts(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    first = store.claim()
    assert store.record_spans(job.job_id,first.lease_token,[timing_span()])
    done = timing_span(state="complete",completed_at=NOW,duration_ms=0)
    assert store.record_spans(job.job_id,first.lease_token,[done])
    clock.advance(minutes=2)
    second = store.claim()
    assert store.record_spans(job.job_id,second.lease_token,[timing_span("second",2)])
    assert store.record_spans(job.job_id,second.lease_token,[timing_span("worker",2)])
    rows = [s for s in store.diagnostics(job.job_id).spans if s.phase == "parsing"]
    assert len(rows) == 2
    assert done in rows
    other = store.create(URL)
    other_claim = store.claim()
    assert store.record_spans(other.job_id,other_claim.lease_token,[timing_span("worker")])
    assert all(s.phase != "parsing" for s in store.diagnostics(other.job_id).spans)


def test_spans_capped_at_64_per_job(diagnostic_store):
    _, store = diagnostic_store
    job = store.create(URL)
    claim = store.claim()
    # The claim already stored one span; submit 69 new worker spans.
    assert store.record_spans(job.job_id,claim.lease_token,[timing_span(str(i)) for i in range(69)])
    result = store.diagnostics(job.job_id)
    assert len(result.spans) == 64
    assert result.omitted == 6
    assert store.record_spans(job.job_id,claim.lease_token,[timing_span("0",state="complete",duration_ms=1)])
    assert store.diagnostics(job.job_id).omitted == 6


def test_complete_records_result_persistence(tmp_path, monkeypatch):
    ticks = iter([0,0.012])
    store = JobStore(str(tmp_path / "persist.db"),MutableClock(),diagnostics_enabled=True,monotonic=lambda: next(ticks))
    try:
        job = store.create(URL)
        claim = store.claim()
        assert store.complete(job.job_id,claim.lease_token,{},[])
        span, = [s for s in store.diagnostics(job.job_id).spans if s.phase == "result_persistence"]
        assert span.duration_ms == 12
        job = store.create(URL)
        claim = store.claim()
        store._monotonic = lambda: 0
        def broken(*args):
            raise RuntimeError("diagnostic write failed")
        monkeypatch.setattr(store,"_write_span",broken)
        assert store.complete(job.job_id,claim.lease_token,{},[])
        assert store.get(job.job_id).status == "completed"
        assert store.create(URL).status == "queued"
    finally:
        store.close()


def test_diagnostics_disabled_writes_nothing(store_context):
    _,clock,store = store_context
    job = store.create(URL)
    first = store.claim()
    assert not store.record_spans(job.job_id,first.lease_token,[timing_span()])
    assert store.fail(job.job_id,first.lease_token,"temporary_failure","network",True)
    clock.advance(seconds=5)
    second = store.claim()
    assert store.complete(job.job_id,second.lease_token,{},[])
    result = store.diagnostics(job.job_id)
    assert (result.collection,result.spans,result.omitted) == ("disabled",[],0)


def test_record_spans_rechecks_lease_after_waiting_for_store_lock(diagnostic_store):
    clock, store = diagnostic_store
    job = store.create(URL)
    claim = store.claim()
    clock.advance(minutes=1, seconds=59)
    result = run_after_store_lock_wait(store, clock,
        lambda: store.record_spans(job.job_id, claim.lease_token, [timing_span()]), seconds=1)
    assert result is False
    assert all(s.phase != "parsing" for s in store.diagnostics(job.job_id).spans)


def test_wait_span_failure_preserves_claim_and_retry(diagnostic_store, monkeypatch):
    _, store = diagnostic_store
    job = store.create(URL)
    def broken(*args):
        raise RuntimeError("diagnostic write failed")
    monkeypatch.setattr(store, "_write_span", broken)
    claim = store.claim()
    assert claim.job_id == job.job_id
    assert store.fail(job.job_id, claim.lease_token, "temporary_failure", "network", True)
    assert store.get(job.job_id).status == "queued"
    assert store.create(URL).status == "queued"
    assert store.diagnostics(job.job_id).spans == []


FINAL = {"reg_number": "123ABC", "reg_number_status": "revealed", "vin": None,
         "vin_status": "not_listed", "vin_format": None}


def listing_with(registration):
    return {"listing_id": "1", "registration": registration.model_dump(mode="json")}


@pytest.fixture
def store_and_claim(store_context):
    _, _, store = store_context
    job = store.create(URL)
    return store, store.claim()


@pytest.fixture
def clock(store_context):
    return store_context[1]


def test_set_registration_replaces_pending(store_and_claim):
    store, claim = store_and_claim
    assert store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    final = dict(FINAL)
    assert store.set_registration(claim.job_id, "rt-1", final, {"engine": "chromium", "attempts": []})
    job = store.get(claim.job_id)
    assert job.listing["registration"] == final
    assert job.listing["listing_id"] == "1"
    assert job.reveal_diagnostics["engine"] == "chromium"
    assert not store.set_registration(claim.job_id, "rt-1", final, None)  # token is single use


def test_set_registration_without_diagnostics_keeps_existing_reveal_row(store_and_claim):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [],
                   {"engine": "first"}, reveal_token="rt-1")
    assert store.set_registration(claim.job_id, "rt-1", FINAL, None)
    assert store.get(claim.job_id).reveal_diagnostics == {"engine": "first"}


def test_late_or_wrong_token_registration_is_rejected(store_and_claim, clock):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    assert not store.set_registration(claim.job_id, "other", FINAL, None)
    clock.advance(seconds=121)
    assert not store.set_registration(claim.job_id, "rt-1", FINAL, None)
    assert store.get(claim.job_id).listing["registration"]["reg_number_status"] == "unavailable"


def test_pending_registration_expires_to_unavailable(store_and_claim, clock):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    assert store.get(claim.job_id).listing["registration"]["vin_status"] == "pending"
    clock.advance(seconds=121)
    reg = store.get(claim.job_id).listing["registration"]
    assert (reg["reg_number_status"], reg["vin_status"]) == ("unavailable", "unavailable")
    assert reg["reg_number"] is None and reg["vin"] is None


def test_pending_without_a_reveal_token_reads_unavailable(store_and_claim):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [])
    reg = store.get(claim.job_id).listing["registration"]
    assert (reg["reg_number_status"], reg["vin_status"]) == ("unavailable", "unavailable")


def test_old_rows_without_reveal_columns_load(tmp_path):
    db = tmp_path / "old-columns.db"
    old = turso.connect(str(db))
    old.execute(
        """
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, status TEXT NOT NULL,
          submitted_at TEXT NOT NULL, started_at TEXT, parsed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
          retry_at TEXT, listing_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
          error_code TEXT, error_message TEXT
        )
        """
    )
    old.execute(
        "INSERT INTO jobs (job_id, source_url, status, submitted_at, parsed_at, listing_json) "
        "VALUES ('job-old', ?, 'completed', '2026-09-27T11:00:00.000000Z', "
        "'2026-09-27T11:00:05.000000Z', '{\"listing_id\": \"0\"}')",
        (URL,),
    )
    old.commit()
    old.close()
    store = JobStore(str(db), MutableClock())
    try:
        assert store.get("job-old").listing.get("registration") is None
    finally:
        store.close()


# Background checks. Fake identity values only.
REG = {"reg_number": "123ABC", "reg_number_status": "revealed", "vin": "WVWZZZ1KZAW000001",
       "vin_status": "listed_in_full", "vin_format": "standard"}
SHA = "a" * 64


def completed_job(store, registration=REG, **complete_args):
    job = store.create(URL)
    claim = store.claim()
    listing = {"listing_id": "1"}
    if registration is not None:
        listing["registration"] = dict(registration)
    assert store.complete(job.job_id, claim.lease_token, listing, [], **complete_args)
    return job.job_id


def fetched(path="/data/background-checks/x.pdf"):
    from auto24_service.store import BackgroundCheckFinish
    return BackgroundCheckFinish(status="fetched", searched_by="reg_number",
                                 pdf_path=path, size_bytes=1234, sha256=SHA)


def test_request_inserts_pending_with_the_reg_number_search(store_context):
    _, clock, store = store_context
    job_id = completed_job(store)
    clock.advance(seconds=5)

    state = store.request_background_check(job_id)

    assert state.status == "pending"
    assert state.requested_at == NOW + timedelta(seconds=5)
    assert (state.searched_by, state.reason, state.sha256) == (None, None, None)
    assert store.background_check(job_id) == state
    claim = store.claim_background_check()
    assert (claim.job_id, claim.search_kind, claim.value) == (job_id, "reg_number", "123ABC")
    assert claim.deadline == state.requested_at + timedelta(seconds=240)


def test_second_request_returns_the_existing_row(store_context):
    _, clock, store = store_context
    job_id = completed_job(store)
    first = store.request_background_check(job_id)
    clock.advance(seconds=3)
    assert store.request_background_check(job_id) == first
    assert store.claim_background_check() is not None
    assert store.claim_background_check() is None


def test_request_falls_back_to_vin(store_context):
    _, _, store = store_context
    for reg_status in ("not_listed", "unavailable"):
        registration = {**REG, "reg_number": None, "reg_number_status": reg_status}
        job_id = completed_job(store, registration)
        assert store.request_background_check(job_id).status == "pending"
        claim = store.claim_background_check()
        assert (claim.job_id, claim.search_kind, claim.value) == (job_id, "vin", "WVWZZZ1KZAW000001")


def test_request_without_identity_is_skipped(store_context):
    _, _, store = store_context
    registration = {"reg_number": None, "reg_number_status": "unavailable", "vin": None,
                    "vin_status": "not_listed", "vin_format": None}
    job_id = completed_job(store, registration)

    state = store.request_background_check(job_id)

    assert (state.status, state.reason, state.searched_by) == ("skipped", "no_identity", None)
    assert state.requested_at == NOW
    assert store.claim_background_check() is None


def test_request_refuses_pending_identity_and_old_jobs(store_context):
    from auto24_service.store import BackgroundCheckRefused
    _, clock, store = store_context
    assert store.request_background_check("missing-job") is None
    assert store.background_check("missing-job") is None

    old_job = completed_job(store, registration=None)
    with pytest.raises(BackgroundCheckRefused):
        store.request_background_check(old_job)
    pending = completed_job(store, Registration.pending().model_dump(mode="json"), reveal_token="rt")
    with pytest.raises(BackgroundCheckRefused):
        store.request_background_check(pending)
    half = {**REG, "vin": None, "vin_status": "pending", "vin_format": None}
    half_pending = completed_job(store, half, reveal_token="rt2")
    with pytest.raises(BackgroundCheckRefused):
        store.request_background_check(half_pending)
    queued = store.create(URL)
    with pytest.raises(BackgroundCheckRefused):
        store.request_background_check(queued.job_id)
    for job_id in (queued.job_id, old_job, pending, half_pending):
        assert store.background_check(job_id).status == "not_requested"
        assert store.background_check(job_id).requested_at is None

    # Once the reveal window closes, a pending identity reads unavailable and the
    # lookup can start with what is known.
    clock.advance(seconds=121)
    assert store.request_background_check(pending).reason == "no_identity"
    assert store.request_background_check(half_pending).status == "pending"


def test_pending_background_check_expires_to_timeout(store_context):
    _, clock, store = store_context
    job_id = completed_job(store)
    store.request_background_check(job_id)
    claim = store.claim_background_check()
    clock.advance(seconds=239)
    assert store.background_check(job_id).status == "pending"

    clock.advance(seconds=1)

    state = store.background_check(job_id)
    assert (state.status, state.reason) == ("unavailable", "timeout")
    assert state.fetched_at is None
    assert store.request_background_check(job_id) == state
    assert not store.finish_background_check(job_id, claim.lease_token, fetched())


def test_expired_pending_row_is_never_claimed(store_context):
    _, clock, store = store_context
    store.request_background_check(completed_job(store))
    clock.advance(seconds=240)
    assert store.claim_background_check() is None


def test_claim_takes_the_oldest_pending_row_and_leases_it(store_context):
    _, clock, store = store_context
    first = completed_job(store)
    second = completed_job(store)
    store.request_background_check(second)
    clock.advance(seconds=1)
    store.request_background_check(first)

    claims = [store.claim_background_check(), store.claim_background_check()]

    assert [c.job_id for c in claims] == [second, first]
    assert claims[0].lease_token != claims[1].lease_token
    assert store.claim_background_check() is None


def test_finish_writes_the_fetched_file(store_context):
    _, clock, store = store_context
    job_id = completed_job(store)
    store.request_background_check(job_id)
    claim = store.claim_background_check()
    clock.advance(seconds=41)

    assert store.finish_background_check(job_id, claim.lease_token, fetched())

    state = store.background_check(job_id)
    assert state.model_dump(mode="json") == {
        "status": "fetched", "requested_at": "2026-09-27T12:00:00Z", "searched_by": "reg_number",
        "reason": None, "fetched_at": "2026-09-27T12:00:41Z", "size_bytes": 1234, "sha256": SHA,
    }
    assert store.background_check_pdf_path(job_id) == "/data/background-checks/x.pdf"
    assert not store.finish_background_check(job_id, claim.lease_token, fetched())
    clock.advance(seconds=300)
    assert store.background_check(job_id).status == "fetched"


def test_finish_writes_each_final_status(store_context):
    from auto24_service.store import BackgroundCheckFinish
    _, _, store = store_context
    outcomes = [BackgroundCheckFinish(status="not_found", searched_by="vin")] + [
        BackgroundCheckFinish(status="unavailable", reason=reason, searched_by=searched_by)
        for reason, searched_by in (("captcha_failed", "reg_number"), ("blocked", "reg_number"),
                                    ("pdf_rejected", "vin"), ("site_changed", None),
                                    ("browser_crash", None))
    ]
    for outcome in outcomes:
        job_id = completed_job(store)
        store.request_background_check(job_id)
        claim = store.claim_background_check()
        assert store.finish_background_check(job_id, claim.lease_token, outcome)
        state = store.background_check(job_id)
        assert (state.status, state.reason, state.searched_by) == (
            outcome.status, outcome.reason, outcome.searched_by)
        assert store.background_check_pdf_path(job_id) is None


def test_finish_outcome_rejects_broken_combinations():
    from pydantic import ValidationError
    from auto24_service.store import BackgroundCheckFinish
    for data in (
        {"status": "pending"},
        {"status": "skipped", "reason": "no_identity"},
        {"status": "fetched", "searched_by": "reg_number"},
        {"status": "unavailable"},
        {"status": "unavailable", "reason": "no_identity"},
        {"status": "not_found", "reason": "blocked", "searched_by": "vin"},
        {"status": "not_found", "searched_by": "vin", "pdf_path": "/x.pdf"},
    ):
        with pytest.raises(ValidationError):
            BackgroundCheckFinish.model_validate(data)


def test_late_or_wrong_token_finish_is_rejected(store_context):
    _, clock, store = store_context
    job_id = completed_job(store)
    store.request_background_check(job_id)
    claim = store.claim_background_check()

    assert not store.finish_background_check(job_id, "other-token", fetched())
    assert not store.finish_background_check("missing-job", claim.lease_token, fetched())
    clock.advance(seconds=240)
    assert not store.finish_background_check(job_id, claim.lease_token, fetched())
    assert store.background_check(job_id).reason == "timeout"
    assert store.background_check_pdf_path(job_id) is None


def test_background_check_survives_reopen(store_context):
    path, clock, store = store_context
    job_id = completed_job(store)
    store.request_background_check(job_id)
    claim = store.claim_background_check()
    store.finish_background_check(job_id, claim.lease_token, fetched())
    before = store.background_check(job_id)
    store.close()
    reopened = JobStore(path, clock)
    try:
        assert reopened.background_check(job_id) == before
    finally:
        reopened.close()


def test_old_databases_gain_the_table(tmp_path):
    path = str(tmp_path / "before-background-checks.db")
    first = JobStore(path, MutableClock())
    job_id = completed_job(first, registration=None)
    first._db.execute("DROP TABLE background_checks")
    first._db.commit()
    first.close()

    store = JobStore(path, MutableClock())
    try:
        assert store.background_check(job_id).status == "not_requested"
        assert store.claim_background_check() is None
        fresh = completed_job(store)
        assert store.request_background_check(fresh).status == "pending"
    finally:
        store.close()
