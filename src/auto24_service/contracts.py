"""Typed JSON response models for job and listing results."""

from datetime import datetime, timezone
from typing import Literal, Self, get_args

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


FieldStatus = Literal["listed_in_full", "revealed", "not_listed", "unavailable", "pending"]
RevealFailureReason = Literal[
    "captcha_rounds_exhausted",
    "try_again_later",
    "timeout",
    "widget_not_found",
    "value_not_found",
    "value_rejected",
    "prefix_mismatch",
    "label_unsupported",
    "browser_error",
    "listing_changed",
]
_VALUE_STATUSES = ("listed_in_full", "revealed")


class Registration(BaseModel):
    reg_number: str | None = None
    reg_number_status: FieldStatus = "not_listed"
    vin: str | None = None
    vin_status: FieldStatus = "not_listed"
    vin_format: Literal["standard", "nonstandard"] | None = None

    @classmethod
    def pending(cls) -> Self:
        return cls(reg_number_status="pending", vin_status="pending")

    @model_validator(mode="after")
    def validate_values_match_statuses(self) -> Self:
        for name in ("reg_number", "vin"):
            has_value = getattr(self, name) is not None
            if has_value != (getattr(self, f"{name}_status") in _VALUE_STATUSES):
                raise ValueError(
                    f"{name} must be set exactly when its status is listed_in_full or revealed"
                )
        if (self.vin is None) != (self.vin_format is None):
            raise ValueError("vin_format must be set exactly when vin is set")
        return self


class TileRecord(BaseModel):
    method: Literal["lookup", "model", "none"]
    score: float | None = None
    selected: bool
    adjusted: bool = False  # changed by the 3-to-4 rule or the 4x4 one-tile rule


# Fixed vocabularies for RoundRecord.stage and AttemptRecord.stage.
RoundStage = Literal[
    "challenge_data",  # waiting for the next challenge after a refused verify
    "tiles",  # waiting for the grid tiles and their images
    "instruction",
    "image",  # reading the grid image
    "solver",
    "click_tiles",
    "refills",  # dynamic 3x3 replacement tiles
    "verify_click",
    "verify_wait",  # waiting for Google's verdict after the verify click
    "done",
]
ROUND_STAGES: tuple[str, ...] = get_args(RoundStage)
AttemptStage = Literal[
    "reopen",  # attempt 2: browser launch and navigation
    "trigger",  # reading the row and clicking the reveal link
    "value_wait",  # waiting for the value, a refusal or the captcha
    "captcha_checkbox",  # waiting for and clicking the checkbox
    "captcha_state",  # after the checkbox: pass, challenge or try-again-later
    "captcha_round",
    "stall",  # Chromium: the extension made no progress for the stall limit
    "done",
]
ATTEMPT_STAGES: tuple[str, ...] = get_args(AttemptStage)


class RoundRecord(BaseModel):
    solver: Literal["python", "extension"] = "python"
    grid: Literal["3x3", "3x3_dynamic", "4x4"]
    instruction: str | None
    label_id: str | None
    label: str | None
    label_source: Literal["id", "name", "instruction", "none"]
    tiles: list[TileRecord]
    tiles_clicked: list[int]
    duration_ms: int
    result: Literal["solved", "incorrect", "try_again_later", "timeout", "label_unsupported"]
    # Where the round was when it ended: one of ROUND_STAGES. None in older payloads.
    stage: RoundStage | None = None
    # A challenge reply came in a format the extension watcher does not know.
    incomplete: bool = False


class AttemptRecord(BaseModel):
    solver: Literal["python", "extension"] = "python"
    attempt: Literal[1, 2]
    started_at: datetime
    duration_ms: int
    outcome: Literal["revealed", "no_captcha_needed", "failed"]
    reason: RevealFailureReason | None = None
    checkbox_only: bool | None = None
    # Exception class name only (never the message) when an exception caused a
    # browser_error or timeout. None in older payloads.
    error_type: str | None = None
    # Where the attempt was when it ended: one of ATTEMPT_STAGES. None in older payloads.
    stage: AttemptStage | None = None
    # "value_only" when a CAPTCHA in this attempt counted as passed only because the
    # value appeared after the widget left the page without a seen tick. None otherwise
    # and in older payloads.
    pass_evidence: Literal["value_only"] | None = None
    rounds: list[RoundRecord] = Field(default_factory=list)
    prefix_check: dict[
        Literal["reg_number", "vin"], Literal["passed", "failed", "skipped"]
    ] = Field(default_factory=dict)
    blocked_requests: list[str] = Field(default_factory=list)  # "host/first-path-segment/"

    @field_validator("started_at")
    @classmethod
    def normalize_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamps must include a UTC offset")
        return value.astimezone(timezone.utc)

    @field_serializer("started_at", when_used="json")
    def serialize_utc(self, value: datetime) -> str:
        return value.isoformat().replace("+00:00", "Z")


class RevealDiagnostics(BaseModel):
    engine: Literal["camoufox", "chromium"] = "camoufox"
    extension_loaded: bool | None = None
    attempts: list[AttemptRecord] = Field(default_factory=list)
    # Fields whose shown value failed the value check before any reveal. Names only.
    initial_rejected: list[Literal["reg_number", "vin"]] = Field(default_factory=list)


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
    registration: Registration | None = None

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
    reveal_diagnostics: RevealDiagnostics | None = None

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
