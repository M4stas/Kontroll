"""Database-independent storage transport models."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Self

from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator

from .contracts import BackgroundCheckReason, SearchKind


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a UTC offset")
    return value.astimezone(timezone.utc)


def _timestamp(value: datetime) -> str:
    return _as_utc(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


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


class BackgroundCheckRefused(Exception):
    """The job cannot start a background check: not completed, no registration, or pending."""


class ClaimedBackgroundCheck(BaseModel):
    job_id: str
    search_kind: SearchKind
    value: str
    lease_token: str
    deadline: datetime

    @field_validator("deadline")
    @classmethod
    def normalize_deadline(cls, value: datetime) -> datetime:
        return _as_utc(value)

    @field_serializer("deadline", when_used="json")
    def serialize_deadline(self, value: datetime) -> str:
        return _timestamp(value)


class BackgroundCheckFinish(BaseModel):
    """A worker's final outcome for one claimed lookup."""

    status: Literal["fetched", "not_found", "unavailable"]
    reason: BackgroundCheckReason | None = None
    searched_by: SearchKind | None = None
    pdf_path: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)
    sha256: str | None = Field(default=None, pattern="^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_outcome(self) -> Self:
        file_fields = (self.pdf_path, self.size_bytes, self.sha256)
        if self.status == "fetched":
            if any(value is None for value in file_fields) or self.searched_by is None:
                raise ValueError("fetched requires searched_by, pdf_path, size_bytes and sha256")
        elif any(value is not None for value in file_fields):
            raise ValueError("only fetched outcomes carry a file")
        if self.status == "unavailable":
            if self.reason in (None, "no_identity"):
                raise ValueError("unavailable requires a worker reason")
        elif self.reason is not None:
            raise ValueError(f"{self.status} has no reason")
        return self


