"""Durable single-process job queue backed by the embedded Turso engine."""

from __future__ import annotations

import json
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator, Literal

import turso
from pydantic import BaseModel, Field, field_serializer, field_validator

from .contracts import (
    BACKGROUND_CHECK_SECONDS,
    REVEAL_SECONDS,
    BackgroundCheckState,
    CaptureDiagnostics,
    CapturePhase,
    CaptureSpan,
)
from .storage_models import (
    BackgroundCheckFinish,
    BackgroundCheckRefused,
    ClaimedBackgroundCheck,
    ClaimedJob,
)


JobStatus = Literal["queued", "running", "completed", "failed"]
_TIME_FIELDS = ("submitted_at", "started_at", "parsed_at", "lease_until", "retry_at")
# How long a claimed job stays leased to its worker.
LEASE_DURATION = timedelta(minutes=2)
_RETRY_DELAYS = (timedelta(seconds=5), timedelta(seconds=30))
_JOB_COLUMNS = """
    job_id, source_url, status, submitted_at, started_at, parsed_at, attempts,
    lease_token, lease_until, retry_at, listing_json, warnings_json,
    error_code, error_message, reveal_until
"""


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a UTC offset")
    return value.astimezone(timezone.utc)


def _timestamp(value: datetime) -> str:
    return _as_utc(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _background_deadline(requested_at: str) -> datetime:
    return datetime.fromisoformat(requested_at) + timedelta(seconds=BACKGROUND_CHECK_SECONDS)


class JobRecord(BaseModel):
    job_id: str
    source_url: str
    status: JobStatus
    submitted_at: datetime
    started_at: datetime | None = None
    parsed_at: datetime | None = None
    attempts: int = 0
    lease_token: str | None = None
    lease_until: datetime | None = None
    retry_at: datetime | None = None
    listing: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    reveal_diagnostics: dict[str, Any] | None = None

    @field_validator(*_TIME_FIELDS)
    @classmethod
    def normalize_time(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _as_utc(value)

    @field_serializer(*_TIME_FIELDS, when_used="json")
    def serialize_time(self, value: datetime | None) -> str | None:
        return None if value is None else _timestamp(value)


class JobStore:
    """Own one serialized Turso connection for the service process."""

    def __init__(
        self, db_path: str, now: Callable[[], datetime], *,
        diagnostics_enabled: bool = False, monotonic: Callable[[], float] = time.monotonic,
    ):
        self._db = turso.connect(db_path)
        self._now = now
        self._lookup_heartbeat_at: datetime | None = None
        self._lookup_signal_started_at = now()
        self._diagnostics_enabled = diagnostics_enabled
        self._monotonic = monotonic
        self._lock = threading.RLock()
        self._closed = False
        with self._lock:
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                  job_id TEXT PRIMARY KEY,
                  source_url TEXT NOT NULL,
                  status TEXT NOT NULL,
                  submitted_at TEXT NOT NULL,
                  started_at TEXT,
                  parsed_at TEXT,
                  attempts INTEGER NOT NULL DEFAULT 0,
                  lease_token TEXT,
                  lease_until TEXT,
                  retry_at TEXT,
                  listing_json TEXT,
                  warnings_json TEXT NOT NULL DEFAULT '[]',
                  error_code TEXT,
                  error_message TEXT
                )
                """
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS jobs_claim_idx "
                "ON jobs(status, retry_at, lease_until, submitted_at)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS job_reveals ("
                "job_id TEXT PRIMARY KEY, reveal_json TEXT NOT NULL)"
            )
            columns = {row[1] for row in self._db.execute("PRAGMA table_info(jobs)").fetchall()}
            if "diagnostic_omitted" not in columns:
                self._db.execute("ALTER TABLE jobs ADD COLUMN diagnostic_omitted INTEGER NOT NULL DEFAULT 0")
            for name in ("reveal_token", "reveal_until"):
                if name not in columns:
                    self._db.execute(f"ALTER TABLE jobs ADD COLUMN {name} TEXT")
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS diagnostic_spans (
                  span_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL,
                  phase TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL,
                  completed_at TEXT, duration_ms REAL, error_code TEXT
                )
            """)
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS diagnostic_omission_reports (
                    job_id TEXT NOT NULL, attempt INTEGER NOT NULL, omitted INTEGER NOT NULL,
                    PRIMARY KEY (job_id, attempt)
                )
            """)
            self._db.execute("CREATE INDEX IF NOT EXISTS diagnostic_spans_job_idx ON diagnostic_spans(job_id, started_at)")
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS background_checks (
                  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
                  status TEXT NOT NULL, requested_at TEXT NOT NULL, searched_by TEXT,
                  search_kind TEXT, reason TEXT, fetched_at TEXT, size_bytes INTEGER,
                  sha256 TEXT, pdf_path TEXT, attempts INTEGER NOT NULL DEFAULT 0,
                  lease_token TEXT, lease_until TEXT
                )
            """)
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS background_checks_claim_idx "
                "ON background_checks(status, requested_at)"
            )
            self._db.commit()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self._db.commit()
        except BaseException:
            self._db.rollback()
            raise

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("JobStore is closed")

    def _record(self, row: tuple[Any, ...] | None) -> JobRecord | None:
        if row is None:
            return None
        (
            job_id,
            source_url,
            status,
            submitted_at,
            started_at,
            parsed_at,
            attempts,
            lease_token,
            lease_until,
            retry_at,
            listing_json,
            warnings_json,
            error_code,
            error_message,
            reveal_until,
        ) = row
        listing = json.loads(listing_json) if listing_json is not None else None
        registration = listing.get("registration") if isinstance(listing, dict) else None
        if isinstance(registration, dict) and (
            reveal_until is None or reveal_until <= _timestamp(self._now())
        ):
            # A reveal that never arrived reads as unavailable; the stored row is left alone.
            for key in ("reg_number_status", "vin_status"):
                if registration.get(key) == "pending":
                    registration[key] = "unavailable"
        return JobRecord(
            job_id=job_id,
            source_url=source_url,
            status=status,
            submitted_at=submitted_at,
            started_at=started_at,
            parsed_at=parsed_at,
            attempts=attempts,
            lease_token=lease_token,
            lease_until=lease_until,
            retry_at=retry_at,
            listing=listing,
            warnings=json.loads(warnings_json),
            error_code=error_code,
            error_message=error_message,
            reveal_diagnostics=self._reveal(job_id),
        )

    def _reveal(self, job_id: str) -> dict[str, Any] | None:
        row = self._db.execute(
            "SELECT reveal_json FROM job_reveals WHERE job_id = ?", (job_id,)
        ).fetchone()
        return None if row is None else json.loads(row[0])

    def create(self, url: str) -> JobRecord:
        job_id = str(uuid.uuid4())
        with self._lock:
            self._ensure_open()
            with self._transaction():
                submitted_at = _timestamp(self._now())
                self._db.execute(
                    "INSERT INTO jobs (job_id, source_url, status, submitted_at) "
                    "VALUES (?, ?, 'queued', ?)",
                    (job_id, url, submitted_at),
                )
            return self._record(
                self._db.execute(
                    f"SELECT {_JOB_COLUMNS} FROM jobs WHERE job_id = ?", (job_id,)
                ).fetchone()
            )

    def get(self, job_id: str) -> JobRecord | None:
        with self._lock:
            self._ensure_open()
            row = self._db.execute(
                f"SELECT {_JOB_COLUMNS} FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            return self._record(row)

    def claim(self) -> ClaimedJob | None:
        with self._lock:
            self._ensure_open()
            with self._transaction():
                current_time = _as_utc(self._now())
                now = _timestamp(current_time)
                lease_until = _timestamp(current_time + LEASE_DURATION)
                self._db.execute(
                    """
                    UPDATE jobs
                    SET status = 'failed', error_code = 'temporary_failure',
                        error_message = 'lease expired after maximum attempts',
                        lease_token = NULL, lease_until = NULL, retry_at = NULL
                    WHERE status = 'running' AND lease_until <= ? AND attempts >= 3
                    """,
                    (now,),
                )
                row = self._db.execute(
                    """
                    SELECT job_id, source_url, attempts, submitted_at, retry_at, lease_until FROM jobs
                    WHERE (status = 'queued' AND (retry_at IS NULL OR retry_at <= ?))
                       OR (status = 'running' AND lease_until <= ? AND attempts < 3)
                    ORDER BY submitted_at, rowid
                    LIMIT 1
                    """,
                    (now, now),
                ).fetchone()
                if row is None:
                    return None
                job_id, source_url, attempts, submitted_at, retry_at, old_lease_until = row
                token = secrets.token_urlsafe(32)
                next_attempt = attempts + 1
                self._db.execute(
                    """
                    UPDATE jobs
                    SET status = 'running',
                        started_at = COALESCE(started_at, ?),
                        attempts = ?,
                        lease_token = ?,
                        lease_until = ?,
                        retry_at = NULL
                    WHERE job_id = ?
                    """,
                    (now, next_attempt, token, lease_until, job_id),
                )
                if self._diagnostics_enabled:
                    eligible_at = datetime.fromisoformat(old_lease_until or retry_at or submitted_at)
                    self._safe_wait_span(job_id, next_attempt, "queue_wait", eligible_at, current_time)
                return ClaimedJob(
                    job_id=job_id,
                    source_url=source_url,
                    attempts=next_attempt,
                    lease_token=token,
                    lease_until=lease_until,
                )

    def complete(
        self,
        job_id: str,
        lease_token: str,
        listing: dict[str, Any],
        warnings: list[str],
        reveal_diagnostics: dict[str, Any] | None = None,
        *, diagnostic_omitted: int = 0, reveal_token: str | None = None,
    ) -> bool:
        listing_json = json.dumps(listing, ensure_ascii=False)
        warnings_json = json.dumps(warnings, ensure_ascii=False)
        with self._lock:
            self._ensure_open()
            started_at = _as_utc(self._now()) if self._diagnostics_enabled else None
            tick = self._monotonic() if self._diagnostics_enabled else None
            with self._transaction():
                parsed_instant = _as_utc(self._now())
                parsed_at = _timestamp(parsed_instant)
                reveal_until = (
                    None if reveal_token is None
                    else _timestamp(parsed_instant + timedelta(seconds=REVEAL_SECONDS))
                )
                attempt_row = self._db.execute("SELECT attempts FROM jobs WHERE job_id = ?", (job_id,)).fetchone() if self._diagnostics_enabled else None
                result = self._db.execute(
                    """
                    UPDATE jobs
                    SET status = 'completed', parsed_at = ?, listing_json = ?,
                        warnings_json = ?, lease_token = NULL, lease_until = NULL,
                        retry_at = NULL, error_code = NULL, error_message = NULL,
                        reveal_token = ?, reveal_until = ?
                    WHERE job_id = ? AND status = 'running' AND lease_token = ?
                      AND lease_until > ?
                    """,
                    (parsed_at, listing_json, warnings_json, reveal_token, reveal_until,
                     job_id, lease_token, parsed_at),
                )
                updated = result.rowcount == 1
                if updated and reveal_diagnostics is not None:
                    self._db.execute(
                        "INSERT OR REPLACE INTO job_reveals (job_id, reveal_json) "
                        "VALUES (?, ?)",
                        (job_id, json.dumps(reveal_diagnostics, ensure_ascii=False)),
                    )
                if updated and attempt_row is not None:
                    self._safe_omitted(job_id, attempt_row[0], diagnostic_omitted)
            if updated and self._diagnostics_enabled:
                # Completion is durable before diagnostic I/O, which must never change its result.
                try:
                    duration_ms = max(0, (self._monotonic() - tick) * 1000)
                    span = CaptureSpan(span_id=str(uuid.uuid4()), attempt=attempt_row[0],
                        phase="result_persistence", state="complete", started_at=started_at,
                        completed_at=self._now(), duration_ms=duration_ms)
                    with self._transaction():
                        self._write_span(job_id, span)
                except Exception:
                    pass
            return updated

    def set_registration(
        self,
        job_id: str,
        reveal_token: str,
        registration: dict[str, Any],
        reveal_diagnostics: dict[str, Any] | None,
    ) -> bool:
        """Fill in a pending identity once, while the reveal window is open."""
        with self._lock:
            self._ensure_open()
            with self._transaction():
                row = self._db.execute(
                    """
                    SELECT listing_json FROM jobs
                    WHERE job_id = ? AND status = 'completed' AND reveal_token = ?
                      AND reveal_until > ?
                    """,
                    (job_id, reveal_token, _timestamp(self._now())),
                ).fetchone()
                if row is None or row[0] is None:
                    return False
                listing = json.loads(row[0])
                listing["registration"] = registration
                self._db.execute(
                    "UPDATE jobs SET listing_json = ?, reveal_token = NULL WHERE job_id = ?",
                    (json.dumps(listing, ensure_ascii=False), job_id),
                )
                if reveal_diagnostics is not None:
                    self._db.execute(
                        "INSERT OR REPLACE INTO job_reveals (job_id, reveal_json) VALUES (?, ?)",
                        (job_id, json.dumps(reveal_diagnostics, ensure_ascii=False)),
                    )
                return True

    def fail(
        self,
        job_id: str,
        lease_token: str,
        code: str,
        message: str,
        transient: bool,
        *, diagnostic_omitted: int = 0,
    ) -> bool:
        with self._lock:
            self._ensure_open()
            with self._transaction():
                failed_at = _as_utc(self._now())
                failed_at_text = _timestamp(failed_at)
                row = self._db.execute(
                    """
                    SELECT attempts FROM jobs
                    WHERE job_id = ? AND status = 'running' AND lease_token = ?
                      AND lease_until > ?
                    """,
                    (job_id, lease_token, failed_at_text),
                ).fetchone()
                if row is None:
                    return False

                attempts = row[0]
                retry = transient and attempts < 3
                retry_at = None
                if retry:
                    retry_at = _timestamp(failed_at + _RETRY_DELAYS[attempts - 1])
                self._db.execute(
                    """
                    UPDATE jobs
                    SET status = ?, error_code = ?, error_message = ?,
                        retry_at = ?, lease_token = NULL, lease_until = NULL
                    WHERE job_id = ?
                    """,
                    (
                        "queued" if retry else "failed",
                        code,
                        message,
                        retry_at,
                        job_id,
                    ),
                )
                self._safe_omitted(job_id, attempts, diagnostic_omitted)
                if retry and self._diagnostics_enabled:
                    self._safe_wait_span(job_id, attempts, "retry_wait", failed_at, datetime.fromisoformat(retry_at))
                return True

    def _write_span(self, job_id: str, span: CaptureSpan) -> None:
        existing = self._db.execute(
            "SELECT job_id, attempt FROM diagnostic_spans WHERE span_id = ?", (span.span_id,)
        ).fetchone()
        if existing is None:
            count = self._db.execute("SELECT COUNT(*) FROM diagnostic_spans WHERE job_id = ?", (job_id,)).fetchone()[0]
            if count >= 64:
                # Count dropped writes, like the worker's recorder: a phase writes when it starts and ends.
                self._db.execute("UPDATE jobs SET diagnostic_omitted = diagnostic_omitted + 1 WHERE job_id = ?", (job_id,))
                return
        self._db.execute("""
            INSERT INTO diagnostic_spans
                (span_id, job_id, attempt, phase, state, started_at, completed_at, duration_ms, error_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(span_id) DO UPDATE SET
                phase = excluded.phase, state = excluded.state, started_at = excluded.started_at,
                completed_at = excluded.completed_at, duration_ms = excluded.duration_ms,
                error_code = excluded.error_code
            WHERE diagnostic_spans.job_id = excluded.job_id AND diagnostic_spans.attempt = excluded.attempt
        """, (span.span_id, job_id, span.attempt, span.phase, span.state, _timestamp(span.started_at),
              None if span.completed_at is None else _timestamp(span.completed_at), span.duration_ms, span.error_code))

    def _safe_wait_span(self, job_id: str, attempt: int, phase: CapturePhase,
                        started_at: datetime, completed_at: datetime) -> None:
        # A collector write failure must not roll back a claim or retry decision.
        self._db.execute("SAVEPOINT diagnostic_wait")
        try:
            self._write_span(job_id, CaptureSpan(span_id=str(uuid.uuid4()), attempt=attempt,
                phase=phase, state="complete", started_at=started_at, completed_at=completed_at,
                duration_ms=max(0, (completed_at - started_at).total_seconds() * 1000)))
        except Exception:
            self._db.execute("ROLLBACK TO diagnostic_wait")
        finally:
            self._db.execute("RELEASE diagnostic_wait")

    def _apply_omitted(self, job_id: str, attempt: int, omitted: int) -> None:
        # The worker reports a cumulative count per attempt; add only the increase.
        previous = self._db.execute(
            "SELECT omitted FROM diagnostic_omission_reports WHERE job_id = ? AND attempt = ?",
            (job_id, attempt),
        ).fetchone()
        accepted = previous[0] if previous else 0
        if omitted > accepted:
            self._db.execute("""
                INSERT INTO diagnostic_omission_reports (job_id, attempt, omitted) VALUES (?, ?, ?)
                ON CONFLICT(job_id, attempt) DO UPDATE SET omitted = excluded.omitted
            """, (job_id, attempt, omitted))
            self._db.execute(
                "UPDATE jobs SET diagnostic_omitted = diagnostic_omitted + ? WHERE job_id = ?",
                (omitted - accepted, job_id),
            )

    def _safe_omitted(self, job_id: str, attempt: int, omitted: int) -> None:
        # A collector write failure must not roll back a completion or failure.
        if not self._diagnostics_enabled or omitted <= 0:
            return
        self._db.execute("SAVEPOINT diagnostic_omitted")
        try:
            self._apply_omitted(job_id, attempt, omitted)
        except Exception:
            self._db.execute("ROLLBACK TO diagnostic_omitted")
        finally:
            self._db.execute("RELEASE diagnostic_omitted")

    def record_spans(self, job_id: str, lease_token: str, spans: list[CaptureSpan], *, omitted: int = 0) -> bool:
        with self._lock:
            self._ensure_open()
            if not self._diagnostics_enabled:
                return False
            with self._transaction():
                row = self._db.execute("""
                    SELECT attempts FROM jobs WHERE job_id = ? AND status = 'running'
                    AND lease_token = ? AND lease_until > ?
                """, (job_id, lease_token, _timestamp(self._now()))).fetchone()
                if row is None or any(span.attempt != row[0] for span in spans):
                    return False
                for span in spans:
                    self._write_span(job_id, span)
                self._apply_omitted(job_id, row[0], omitted)
                return True

    def diagnostics(self, job_id: str) -> CaptureDiagnostics | None:
        with self._lock:
            self._ensure_open()
            row = self._db.execute("SELECT diagnostic_omitted, status, attempts, lease_until FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            if row is None:
                return None
            rows = self._db.execute("""
                SELECT span_id, attempt, phase, state, started_at, completed_at, duration_ms, error_code
                FROM diagnostic_spans WHERE job_id = ? ORDER BY started_at, rowid
            """, (job_id,)).fetchall()
            keys = ("span_id", "attempt", "phase", "state", "started_at", "completed_at", "duration_ms", "error_code")
            spans = [CaptureSpan(**dict(zip(keys, values))) for values in rows]
            if self._diagnostics_enabled:
                active = (row[1] == "running" and row[3] is not None
                          and datetime.fromisoformat(row[3]) > _as_utc(self._now()))
                # An abandoned phase has no reliable end time or cross-process duration.
                spans = [
                    span.model_copy(update={"state": "incomplete", "error_code": "collection_incomplete",
                                            "completed_at": None, "duration_ms": None})
                    if span.state == "running" and not (active and span.attempt == row[2])
                    else span
                    for span in spans
                ]
            return CaptureDiagnostics(job_id=job_id,
                collection="enabled" if self._diagnostics_enabled else "disabled",
                spans=spans, omitted=row[0])

    def lookup_worker_heartbeat(self) -> None:
        with self._lock:
            self._ensure_open()
            self._lookup_heartbeat_at = self._now()

    def _lookup_worker_available(self) -> bool:
        return (self._lookup_heartbeat_at is not None and
                self._now() - self._lookup_heartbeat_at < timedelta(seconds=20))

    def _background_state(self, job_id: str) -> BackgroundCheckState | None:
        row = self._db.execute(
            "SELECT status, requested_at, searched_by, reason, fetched_at, size_bytes, sha256 "
            "FROM background_checks WHERE job_id = ?", (job_id,),
        ).fetchone()
        if row is None:
            return None
        status, requested_at, searched_by, reason, fetched_at, size_bytes, sha256 = row
        if status == "pending" and self._now() >= _background_deadline(requested_at):
            # A lookup that never finished reads as a timeout; the stored row is left alone.
            status, reason = "unavailable", "timeout"
        elif status == "pending" and self._now() >= max(
            datetime.fromisoformat(requested_at), self._lookup_signal_started_at
        ) + timedelta(seconds=20):
            try:
                available = self._lookup_worker_available()
            except Exception:
                available = True
            if not available:
                # Claimed lookups keep their original deadline even if their worker dies.
                self._db.execute(
                    "UPDATE background_checks SET status = 'unavailable', reason = 'browser_crash' "
                    "WHERE job_id = ? AND status = 'pending' AND attempts = 0", (job_id,),
                )
                stored = self._db.execute(
                    "SELECT status, reason FROM background_checks WHERE job_id = ?", (job_id,),
                ).fetchone()
                status, reason = stored
        return BackgroundCheckState(
            status=status, requested_at=requested_at, searched_by=searched_by, reason=reason,
            fetched_at=fetched_at, size_bytes=size_bytes, sha256=sha256,
        )

    def request_background_check(self, job_id: str) -> BackgroundCheckState | None:
        """Start one lookup per job. None for an unknown job; refused while it cannot start."""
        with self._lock:
            self._ensure_open()
            with self._transaction():
                job = self._record(self._db.execute(
                    f"SELECT {_JOB_COLUMNS} FROM jobs WHERE job_id = ?", (job_id,)
                ).fetchone())
                if job is None:
                    return None
                existing = self._background_state(job_id)
                if existing is not None:
                    return existing
                if job.status != "completed":
                    raise BackgroundCheckRefused("job is not completed")
                registration = (job.listing or {}).get("registration")
                if not isinstance(registration, dict):
                    raise BackgroundCheckRefused("job has no registration")
                if "pending" in (registration.get("reg_number_status"), registration.get("vin_status")):
                    raise BackgroundCheckRefused("identity is still pending")
                if registration.get("reg_number_status") in ("listed_in_full", "revealed"):
                    search_kind, status, reason = "reg_number", "pending", None
                elif registration.get("vin"):
                    search_kind, status, reason = "vin", "pending", None
                else:
                    search_kind, status, reason = None, "skipped", "no_identity"
                self._db.execute(
                    "INSERT INTO background_checks (job_id, status, requested_at, search_kind, reason) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (job_id, status, _timestamp(self._now()), search_kind, reason),
                )
                return self._background_state(job_id)

    def background_check(self, job_id: str) -> BackgroundCheckState | None:
        with self._lock:
            self._ensure_open()
            if self._db.execute("SELECT 1 FROM jobs WHERE job_id = ?", (job_id,)).fetchone() is None:
                return None
            with self._transaction():
                return self._background_state(job_id) or BackgroundCheckState(status="not_requested")

    def background_check_pdf_path(self, job_id: str) -> str | None:
        with self._lock:
            self._ensure_open()
            row = self._db.execute(
                "SELECT pdf_path FROM background_checks WHERE job_id = ? AND status = 'fetched'",
                (job_id,),
            ).fetchone()
            return None if row is None else row[0]

    def claim_background_check(self) -> ClaimedBackgroundCheck | None:
        """Lease the oldest pending lookup until its deadline, which covers both in-browser attempts."""
        with self._lock:
            self._ensure_open()
            with self._transaction():
                current_time = _as_utc(self._now())
                now = _timestamp(current_time)
                oldest_live = _timestamp(current_time - timedelta(seconds=BACKGROUND_CHECK_SECONDS))
                row = self._db.execute(
                    """
                    SELECT b.job_id, b.search_kind, b.requested_at, j.listing_json
                    FROM background_checks b JOIN jobs j ON j.job_id = b.job_id
                    WHERE b.status = 'pending' AND b.attempts < 2 AND b.requested_at > ?
                      AND (b.lease_until IS NULL OR b.lease_until <= ?)
                    ORDER BY b.requested_at, b.rowid
                    LIMIT 1
                    """,
                    (oldest_live, now),
                ).fetchone()
                if row is None:
                    return None
                job_id, search_kind, requested_at, listing_json = row
                deadline = _background_deadline(requested_at)
                token = secrets.token_urlsafe(32)
                self._db.execute(
                    "UPDATE background_checks SET attempts = attempts + 1, lease_token = ?, "
                    "lease_until = ? WHERE job_id = ?",
                    (token, _timestamp(deadline), job_id),
                )
                value = json.loads(listing_json)["registration"][search_kind]
                return ClaimedBackgroundCheck(job_id=job_id, search_kind=search_kind, value=value,
                                              lease_token=token, deadline=deadline)

    def finish_background_check(self, job_id: str, lease_token: str,
                                outcome: BackgroundCheckFinish) -> bool:
        with self._lock:
            self._ensure_open()
            with self._transaction():
                current_time = _as_utc(self._now())
                row = self._db.execute(
                    "SELECT requested_at FROM background_checks "
                    "WHERE job_id = ? AND status = 'pending' AND lease_token = ?",
                    (job_id, lease_token),
                ).fetchone()
                if row is None or current_time >= _background_deadline(row[0]):
                    return False
                fetched_at = _timestamp(current_time) if outcome.status == "fetched" else None
                self._db.execute(
                    """
                    UPDATE background_checks
                    SET status = ?, reason = ?, searched_by = ?, fetched_at = ?, size_bytes = ?,
                        sha256 = ?, pdf_path = ?, lease_token = NULL, lease_until = NULL
                    WHERE job_id = ?
                    """,
                    (outcome.status, outcome.reason, outcome.searched_by, fetched_at,
                     outcome.size_bytes, outcome.sha256, outcome.pdf_path, job_id),
                )
                return True

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._db.close()
                self._closed = True
