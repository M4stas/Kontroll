"""Typed JSON response models for job and listing results."""

from datetime import datetime, timezone
from typing import Literal, Self

from pydantic import (
    BaseModel,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)


JobErrorCode = Literal[
    "listing_gone",
    "access_blocked",
    "unsupported_vehicle_type",
    "parse_failed",
    "temporary_failure",
]


class JobError(BaseModel):
    code: JobErrorCode
    message: str


class ListingPrice(BaseModel):
    amount: int | float | None = None
    currency: str | None = None


class SellerInfo(BaseModel):
    name: str | None = None
    type: str | None = None
    location: str | None = None


class ListingResult(BaseModel):
    source_url: str
    listing_id: str
    title: str | None = None
    make: str | None = None
    model: str | None = None
    first_registration: str | None = None
    year: int | None = None
    year_source: Literal["first_registration"] | None = None
    price: ListingPrice | None = None
    mileage_km: int | None = None
    body_type: str | None = None
    fuel: str | None = None
    power_kw: int | None = None
    gearbox: str | None = None
    drivetrain: str | None = None
    colour: str | None = None
    seller_description: str | None = None
    seller: SellerInfo | None = None
    equipment: dict[str, list[str]] = Field(default_factory=dict)
    technical_specs: dict[str, str] = Field(default_factory=dict)
    other_fields: dict[str, str] = Field(default_factory=dict)
    photo_urls: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_year_source(self) -> Self:
        if (self.year is None) != (self.year_source is None):
            raise ValueError("year and year_source must be provided together")
        return self


class JobResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    submitted_at: datetime
    status_url: str | None = None
    parsed_at: datetime | None = None
    listing: ListingResult | None = None
    error: JobError | None = None
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_status_fields(self) -> Self:
        if self.status == "completed":
            has_result = self.listing is not None and self.parsed_at is not None
            if not has_result or self.error is not None:
                raise ValueError("completed jobs require result data without an error")
        elif self.status in ("queued", "running"):
            has_result = self.listing is not None or self.parsed_at is not None
            if has_result or self.error is not None:
                raise ValueError("queued and running jobs cannot have results or errors")
        elif self.status == "failed":
            if self.error is None:
                raise ValueError("failed jobs require an error")
            if self.listing is not None or self.parsed_at is not None:
                raise ValueError("failed jobs cannot include listing results")
        return self

    @field_validator("submitted_at", "parsed_at")
    @classmethod
    def normalize_utc(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamps must include a UTC offset")
        return value.astimezone(timezone.utc)

    @field_serializer("submitted_at", "parsed_at", when_used="json")
    def serialize_utc(self, value: datetime | None) -> str | None:
        if value is None:
            return None
        return value.isoformat().replace("+00:00", "Z")


CapturePhase = Literal[
    "queue_wait", "retry_wait", "browser_start", "page_setup", "navigation",
    "html_retrieval", "validation", "parsing", "browser_shutdown", "result_persistence",
]
CaptureSpanState = Literal["running", "complete", "failed", "incomplete"]


class CaptureSpan(BaseModel):
    model_config = {"extra": "forbid"}

    span_id: str
    attempt: int = Field(ge=1)
    phase: CapturePhase
    state: CaptureSpanState
    started_at: datetime
    completed_at: datetime | None = None
    duration_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    error_code: Literal["phase_failed", "collection_incomplete"] | None = None

    @field_validator("started_at", "completed_at")
    @classmethod
    def normalize_utc(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamps must include a UTC offset")
        return value.astimezone(timezone.utc)

    @field_serializer("started_at", "completed_at", when_used="json")
    def serialize_utc(self, value: datetime | None) -> str | None:
        return None if value is None else value.isoformat().replace("+00:00", "Z")


class CaptureDiagnostics(BaseModel):
    job_id: str
    collection: Literal["enabled", "disabled"]
    spans: list[CaptureSpan]
    omitted: int = Field(ge=0)
