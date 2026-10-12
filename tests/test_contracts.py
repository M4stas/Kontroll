import pytest
from pydantic import ValidationError

from auto24_service.contracts import JobError, JobResponse, ListingResult


LISTING_DATA = {"source_url": "https://www.auto24.ee/soidukid/1", "listing_id": "1"}
ERROR = JobError(code="parse_failed", message="Could not parse listing")
TIMESTAMP = "2026-09-26T14:28:18Z"
JOB_DATA = {"job_id": "j1", "submitted_at": "2026-09-26T14:28:00Z"}


def test_completed_job_serializes_parse_time_as_utc_z():
    response = JobResponse(
        job_id="j1",
        status="completed",
        submitted_at="2026-09-26T14:28:00Z",
        parsed_at="2026-09-26T14:28:18Z",
        listing=ListingResult(
            source_url="https://www.auto24.ee/soidukid/1",
            listing_id="1",
            title="Example",
        ),
    )

    assert response.model_dump(mode="json")["parsed_at"] == "2026-09-26T14:28:18Z"


def test_submit_response_has_nullable_status_url():
    response = JobResponse(
        job_id="j1",
        status="queued",
        submitted_at="2026-09-26T14:28:00Z",
        status_url="/v1/jobs/j1",
    )

    assert response.status_url == "/v1/jobs/j1"
    assert response.parsed_at is None
    assert response.listing is None


def test_listing_optional_fields_and_collections_have_contract_defaults():
    listing = ListingResult(**LISTING_DATA)

    assert listing.year is None
    assert listing.year_source is None
    assert listing.price is None
    assert listing.seller is None
    assert listing.equipment == {}
    assert listing.technical_specs == {}
    assert listing.other_fields == {}
    assert listing.photo_urls == []


@pytest.mark.parametrize(
    "state_fields",
    [
        {"status": "completed", "parsed_at": TIMESTAMP},
        {"status": "completed", "listing": LISTING_DATA},
        {"status": "queued", "listing": LISTING_DATA},
        {"status": "queued", "parsed_at": TIMESTAMP},
        {"status": "queued", "error": ERROR},
        {"status": "running", "listing": LISTING_DATA},
        {"status": "running", "parsed_at": TIMESTAMP},
        {"status": "running", "error": ERROR},
        {"status": "failed"},
        {"status": "failed", "error": ERROR, "listing": LISTING_DATA},
        {"status": "failed", "error": ERROR, "parsed_at": TIMESTAMP},
    ],
)
def test_job_response_rejects_invalid_state_fields(state_fields):
    with pytest.raises(ValidationError):
        JobResponse(**JOB_DATA, **state_fields)


def test_failed_job_accepts_error():
    assert JobResponse(**JOB_DATA, status="failed", error=ERROR).error == ERROR


def test_completed_job_rejects_error():
    with pytest.raises(ValidationError):
        JobResponse(
            **JOB_DATA,
            status="completed",
            parsed_at=TIMESTAMP,
            listing=LISTING_DATA,
            error=ERROR,
        )


@pytest.mark.parametrize(
    "year_fields",
    [{"year": 2022}, {"year_source": "first_registration"}],
)
def test_year_and_year_source_must_appear_together(year_fields):
    with pytest.raises(ValidationError):
        ListingResult(
            **LISTING_DATA,
            **year_fields,
        )


def test_year_from_first_registration_accepts_matching_source():
    ListingResult(**LISTING_DATA, year=2022, year_source="first_registration")


def test_registration_requires_value_exactly_when_listed_or_revealed():
    from auto24_service.contracts import Registration

    with pytest.raises(ValidationError):
        Registration(reg_number_status="revealed")
    with pytest.raises(ValidationError):
        Registration(reg_number="1", reg_number_status="unavailable")
    with pytest.raises(ValidationError):
        Registration(vin_status="listed_in_full")
    with pytest.raises(ValidationError):
        Registration(vin="WVWZZZ1JZXW000001", vin_status="not_listed", vin_format="standard")
    with pytest.raises(ValidationError):
        Registration(vin_format="standard")
    with pytest.raises(ValidationError):
        Registration(vin="WVWZZZ1JZXW000001", vin_status="revealed")

    ok = Registration(
        reg_number="123ABC",
        reg_number_status="revealed",
        vin="WVWZZZ1JZXW000001",
        vin_status="listed_in_full",
        vin_format="standard",
    )
    assert ok.reg_number == "123ABC"
    assert Registration().reg_number_status == "not_listed"


def test_job_response_without_new_fields_still_parses():
    payload = {
        "job_id": "j1",
        "status": "completed",
        "submitted_at": "2026-09-26T14:28:00Z",
        "status_url": None,
        "parsed_at": "2026-09-26T14:28:18Z",
        "listing": {"source_url": "https://www.auto24.ee/soidukid/1", "listing_id": "1"},
        "error": None,
        "warnings": [],
    }
    response = JobResponse.model_validate(payload)
    assert response.reveal_diagnostics is None
    assert response.listing.registration is None


def test_reveal_diagnostics_round_trip_and_hold_no_secret_fields():
    from auto24_service.contracts import AttemptRecord, RevealDiagnostics, RoundRecord, TileRecord

    diagnostics = RevealDiagnostics(
        attempts=[
            AttemptRecord(
                attempt=1,
                started_at="2026-09-26T14:28:00Z",
                duration_ms=1200,
                outcome="failed",
                reason="captcha_rounds_exhausted",
                rounds=[
                    RoundRecord(
                        grid="3x3",
                        instruction="Select all images with buses",
                        label_id="/m/01bjv",
                        label="bus",
                        label_source="id",
                        tiles=[TileRecord(method="model", score=0.9, selected=True)],
                        tiles_clicked=[0],
                        duration_ms=800,
                        result="incorrect",
                    )
                ],
                prefix_check={"reg_number": "skipped"},
                blocked_requests=["www.google.com/recaptcha/"],
            )
        ]
    )
    again = RevealDiagnostics.model_validate(diagnostics.model_dump(mode="json"))
    assert again == diagnostics
    forbidden = {"cookies", "token", "tokens", "body", "image", "images", "reg_number", "vin", "value"}
    for model in (AttemptRecord, RoundRecord, TileRecord, RevealDiagnostics):
        assert not forbidden & set(model.model_fields)


def test_old_attempt_and_round_payloads_parse_with_new_fields_unset():
    from auto24_service.contracts import AttemptRecord, ATTEMPT_STAGES, ROUND_STAGES

    old = {
        "attempt": 1,
        "started_at": "2026-09-26T14:28:00Z",
        "duration_ms": 90000,
        "outcome": "failed",
        "reason": "timeout",
        "rounds": [
            {
                "grid": "3x3", "instruction": None, "label_id": None, "label": None,
                "label_source": "none", "tiles": [], "tiles_clicked": [], "duration_ms": 5,
                "result": "timeout",
            }
        ],
    }
    record = AttemptRecord.model_validate(old)
    assert record.error_type is None and record.stage is None
    assert record.rounds[0].stage is None
    assert "verify_wait" in ROUND_STAGES and "reopen" in ATTEMPT_STAGES
