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
