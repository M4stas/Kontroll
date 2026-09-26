from auto24_service.contracts import JobResponse, ListingResult


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
    listing = ListingResult(
        source_url="https://www.auto24.ee/soidukid/1",
        listing_id="1",
    )

    assert listing.year is None
    assert listing.year_source is None
    assert listing.price is None
    assert listing.seller is None
    assert listing.equipment == {}
    assert listing.technical_specs == {}
    assert listing.other_fields == {}
    assert listing.photo_urls == []
