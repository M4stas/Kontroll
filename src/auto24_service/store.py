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

from .contracts import CaptureDiagnostics, CapturePhase, CaptureSpan


JobStatus = Literal["queued", "running", "completed", "failed"]
_TIME_FIELDS = ("submitted_at", "started_at", "parsed_at", "lease_until", "retry_at")
_RETRY_DELAYS = (timedelta(seconds=5), timedelta(seconds=30))
_JOB_COLUMNS = """
    job_id, source_url, status, submitted_at, started_at, parsed_at, attempts,
    lease_token, lease_until, retry_at, listing_json, warnings_json,
    error_code, error_message
"""


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a UTC offset")
    return value.astimezone(timezone.utc)


def _timestamp(value: datetime) -> str:
    return _as_utc(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


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

    @field_validator(*_TIME_FIELDS)
    @classmethod
    def normalize_time(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _as_utc(value)

    @field_serializer(*_TIME_FIELDS, when_used="json")
    def serialize_time(self, value: datetime | None) -> str | None:
        return None if value is None else _timestamp(value)


class ClaimedJob(BaseModel):
    job_id: str
    source_url: str
    attempts: int
    lease_token: str
    lease_until: datetime

    @field_validator("lease_until")
    @classmethod
    def normalize_lease_time(cls, value: datetime) -> datetime:
        return _as_utc(value)

    @field_serializer("lease_until", when_used="json")
    def serialize_lease_time(self, value: datetime) -> str:
        return _timestamp(value)


class JobStore:
    """Own one serialized Turso connection for the service process."""

    def __init__(
        self, db_path: str, now: Callable[[], datetime], *,
        diagnostics_enabled: bool = False, monotonic: Callable[[], float] = time.monotonic,
    ):
        self._db = turso.connect(db_path)
        self._now = now
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
            columns = {row[1] for row in self._db.execute("PRAGMA table_info(jobs)").fetchall()}
            if "diagnostic_omitted" not in columns:
                self._db.execute("ALTER TABLE jobs ADD COLUMN diagnostic_omitted INTEGER NOT NULL DEFAULT 0")
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
        ) = row
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
            listing=json.loads(listing_json) if listing_json is not None else None,
            warnings=json.loads(warnings_json),
            error_code=error_code,
            error_message=error_message,
        )

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
                lease_until = _timestamp(current_time + timedelta(minutes=2))
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
    ) -> bool:
        listing_json = json.dumps(listing, ensure_ascii=False)
        warnings_json = json.dumps(warnings, ensure_ascii=False)
        with self._lock:
            self._ensure_open()
            started_at = _as_utc(self._now()) if self._diagnostics_enabled else None
            tick = self._monotonic() if self._diagnostics_enabled else None
            with self._transaction():
                parsed_at = _timestamp(self._now())
                attempt_row = self._db.execute("SELECT attempts FROM jobs WHERE job_id = ?", (job_id,)).fetchone() if self._diagnostics_enabled else None
                result = self._db.execute(
                    """
                    UPDATE jobs
                    SET status = 'completed', parsed_at = ?, listing_json = ?,
                        warnings_json = ?, lease_token = NULL, lease_until = NULL,
                        retry_at = NULL, error_code = NULL, error_message = NULL
                    WHERE job_id = ? AND status = 'running' AND lease_token = ?
                      AND lease_until > ?
                    """,
                    (parsed_at, listing_json, warnings_json, job_id, lease_token, parsed_at),
                )
                updated = result.rowcount == 1
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

    def fail(
        self,
        job_id: str,
        lease_token: str,
        code: str,
        message: str,
        transient: bool,
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
                previous = self._db.execute(
                    "SELECT omitted FROM diagnostic_omission_reports WHERE job_id = ? AND attempt = ?",
                    (job_id, row[0]),
                ).fetchone()
                accepted = previous[0] if previous else 0
                if omitted > accepted:
                    self._db.execute("""
                        INSERT INTO diagnostic_omission_reports (job_id, attempt, omitted) VALUES (?, ?, ?)
                        ON CONFLICT(job_id, attempt) DO UPDATE SET omitted = excluded.omitted
                    """, (job_id, row[0], omitted))
                    self._db.execute(
                        "UPDATE jobs SET diagnostic_omitted = diagnostic_omitted + ? WHERE job_id = ?",
                        (omitted - accepted, job_id),
                    )
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

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._db.close()
                self._closed = True
