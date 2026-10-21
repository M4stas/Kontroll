import asyncio
from datetime import datetime, timezone

import httpx
import pytest

import auto24_service.public_api as public_api
from auto24_service.contracts import JobResponse, ListingResult
from auto24_service.public_api import create_public_app
from auto24_service.storage_client import StorageUnavailableError


URL = "https://www.auto24.ee/soidukid/1"
KEY = "public-test-secret"
NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


class FakeStorageClient:
    def __init__(self, job=None, failure=None):
        self.job = job or JobResponse(job_id="job-1", status="queued", submitted_at=NOW)
        self.failure = failure
        self.created_urls = []
        self.requested_ids = []

    def create(self, url):
        self.created_urls.append(url)
        if self.failure:
            raise self.failure
        return self.job

    def get(self, job_id):
        self.requested_ids.append(job_id)
        if self.failure:
            raise self.failure
        return self.job if job_id == self.job.job_id else None


def request(app, callback):
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://public.test"
        ) as client:
            return await callback(client)

    return asyncio.run(run())


def test_submit_and_poll_reject_missing_or_wrong_api_key():
    storage = FakeStorageClient()
    app = create_public_app(storage, KEY)

    async def exercise(client):
        responses = []
        for headers in ({}, {"X-API-Key": "wrong"}):
            responses.append(
                await client.post("/v1/jobs", headers=headers, json={"url": URL})
            )
            responses.append(await client.get("/v1/jobs/job-1", headers=headers))
        return responses

    assert [item.status_code for item in request(app, exercise)] == [401] * 4
    assert storage.created_urls == []
    assert storage.requested_ids == []


def test_empty_configured_key_fails_closed():
    storage = FakeStorageClient()
    app = create_public_app(storage, "")

    async def exercise(client):
        return await client.post(
            "/v1/jobs", headers={"X-API-Key": "anything"}, json={"url": URL}
        )

    assert request(app, exercise).status_code == 401
    assert storage.created_urls == []


def test_missing_key_is_rejected_before_malformed_body_validation():
    app = create_public_app(FakeStorageClient(), KEY)

    async def exercise(client):
        return await client.post(
            "/v1/jobs", headers={"Content-Type": "application/json"}, content="{"
        )

    assert request(app, exercise).status_code == 401


@pytest.mark.parametrize(
    "url",
    [
        "http://auto24.ee/soidukid/1",
        "https://example.com/soidukid/1",
        "https://auto24.ee/search",
    ],
)
def test_submit_rejects_invalid_url_before_storage(url):
    storage = FakeStorageClient()
    app = create_public_app(storage, KEY)

    async def exercise(client):
        return await client.post(
            "/v1/jobs", headers={"X-API-Key": KEY}, json={"url": url}
        )

    assert request(app, exercise).status_code == 400
    assert storage.created_urls == []


def test_submit_canonicalizes_url_and_returns_accepted_job_with_poll_path():
    storage = FakeStorageClient()
    app = create_public_app(storage, KEY)

    async def exercise(client):
        return await client.post(
            "/v1/jobs",
            headers={"X-API-Key": KEY},
            json={"url": "https://auto24.ee/soidukid/1?utm_source=test"},
        )

    response = request(app, exercise)
    assert response.status_code == 202
    assert storage.created_urls == [URL]
    assert response.json() == {
        "job_id": "job-1",
        "status": "queued",
        "submitted_at": "2026-09-27T12:00:00Z",
        "status_url": "/v1/jobs/job-1",
        "parsed_at": None,
        "listing": None,
        "error": None,
        "warnings": [],
        "reveal_diagnostics": None,
    }


def test_poll_unknown_job_returns_404():
    storage = FakeStorageClient()
    app = create_public_app(storage, KEY)

    async def exercise(client):
        return await client.get("/v1/jobs/missing", headers={"X-API-Key": KEY})

    assert request(app, exercise).status_code == 404
    assert storage.requested_ids == ["missing"]


def test_poll_completed_job_retains_utc_parsed_at_and_listing():
    listing = ListingResult(source_url=URL, listing_id="1", title="Example car")
    job = JobResponse(
        job_id="job-1",
        status="completed",
        submitted_at=NOW,
        parsed_at=datetime(2026, 9, 27, 15, 2, tzinfo=timezone.utc),
        listing=listing,
        warnings=["missing mileage"],
    )
    app = create_public_app(FakeStorageClient(job=job), KEY)

    async def exercise(client):
        return await client.get("/v1/jobs/job-1", headers={"X-API-Key": KEY})

    response = request(app, exercise)
    assert response.status_code == 200
    assert response.json()["parsed_at"] == "2026-09-27T15:02:00Z"
    assert response.json()["listing"]["listing_id"] == "1"
    assert response.json()["warnings"] == ["missing mileage"]


@pytest.mark.parametrize("method", ["post", "get"])
def test_storage_unavailability_returns_503(method):
    storage = FakeStorageClient(failure=StorageUnavailableError("offline"))
    app = create_public_app(storage, KEY)

    async def exercise(client):
        if method == "post":
            return await client.post(
                "/v1/jobs", headers={"X-API-Key": KEY}, json={"url": URL}
            )
        return await client.get("/v1/jobs/job-1", headers={"X-API-Key": KEY})

    assert request(app, exercise).status_code == 503


def test_health_does_not_require_api_key():
    app = create_public_app(FakeStorageClient(), KEY)

    async def exercise(client):
        return await client.get("/health")

    response = request(app, exercise)
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_runnable_app_uses_deployment_environment(monkeypatch):
    storage = FakeStorageClient()
    configured = []

    def build_client(storage_url, internal_key):
        configured.append((storage_url, internal_key))
        return storage

    monkeypatch.setenv("STORAGE_URL", "http://storage.internal:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "internal-secret")
    monkeypatch.setenv("PUBLIC_API_KEY", KEY)
    monkeypatch.setattr(public_api, "StorageClient", build_client)
    app = public_api.create_runnable_public_app()

    async def exercise(client):
        return await client.post(
            "/v1/jobs", headers={"X-API-Key": KEY}, json={"url": URL}
        )

    assert request(app, exercise).status_code == 202
    assert configured == [("http://storage.internal:8001", "internal-secret")]


def test_module_level_app_exposes_unauthenticated_health():
    async def exercise(client):
        return await client.get("/health")

    assert request(public_api.app, exercise).status_code == 200


def test_public_diagnostics_never_contains_lease_token_or_url(tmp_path):
    from auto24_service.store import JobStore
    from auto24_service.contracts import CaptureSpan
    with_store = JobStore(str(tmp_path / 'diagnostics.db'), lambda: NOW, diagnostics_enabled=True)
    try:
        job = with_store.create(URL)
        claim = with_store.claim()
        with_store.record_spans(job.job_id, claim.lease_token, [CaptureSpan(span_id='parse', attempt=1, phase='parsing', state='running', started_at=NOW)])
        app = create_public_app(with_store, KEY)
        async def exercise(client):
            return await client.get(f'/v1/jobs/{job.job_id}/diagnostics', headers={'X-API-Key': KEY})
        response = request(app, exercise)
        assert response.status_code == 200
        assert claim.lease_token not in response.text
        assert 'auto24.ee' not in response.text
        assert set(response.json()) == {'job_id', 'collection', 'spans', 'omitted'}
    finally:
        with_store.close()


@pytest.mark.parametrize('down, expected', [(False, 404), (True, 503)])
def test_public_diagnostics_unknown_job_and_storage_down(down, expected):
    class DiagnosticsClient:
        def diagnostics(self, job_id):
            if down:
                raise StorageUnavailableError('offline')
            return None
    app = create_public_app(DiagnosticsClient(), KEY)
    async def exercise(client):
        return await client.get('/v1/jobs/missing/diagnostics', headers={'X-API-Key': KEY})
    assert request(app, exercise).status_code == expected
