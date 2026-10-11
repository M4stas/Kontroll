"""Durable single-process job queue backed by the embedded Turso engine."""

from __future__ import annotations

import json
import secrets
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator, Literal

import turso
from pydantic import BaseModel, Field, field_serializer, field_validator


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
    reveal_diagnostics: dict[str, Any] | None = None

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

    def __init__(self, db_path: str, now: Callable[[], datetime]):
        self._db = turso.connect(db_path)
        self._now = now
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
                    SELECT job_id, source_url, attempts FROM jobs
                    WHERE (status = 'queued' AND (retry_at IS NULL OR retry_at <= ?))
                       OR (status = 'running' AND lease_until <= ? AND attempts < 3)
                    ORDER BY submitted_at, rowid
                    LIMIT 1
                    """,
                    (now, now),
                ).fetchone()
                if row is None:
                    return None
                job_id, source_url, attempts = row
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
    ) -> bool:
        listing_json = json.dumps(listing, ensure_ascii=False)
        warnings_json = json.dumps(warnings, ensure_ascii=False)
        with self._lock:
            self._ensure_open()
            with self._transaction():
                parsed_at = _timestamp(self._now())
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
                if updated and reveal_diagnostics is not None:
                    self._db.execute(
                        "INSERT OR REPLACE INTO job_reveals (job_id, reveal_json) "
                        "VALUES (?, ?)",
                        (job_id, json.dumps(reveal_diagnostics, ensure_ascii=False)),
                    )
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
                return True

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._db.close()
                self._closed = True
