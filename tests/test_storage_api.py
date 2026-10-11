import asyncio
from datetime import datetime, timezone

import httpx
import pytest

import auto24_service.storage_api as storage_api
from auto24_service.storage_api import create_runnable_storage_app, create_storage_app
from auto24_service.store import JobStore


URL = "https://www.auto24.ee/soidukid/1"
KEY = "storage-test-secret"
NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
LISTING = {
    "source_url": URL,
    "listing_id": "1",
    "title": "Example car",
    "equipment": {},
    "technical_specs": {},
    "other_fields": {},
    "photo_urls": [],
}


@pytest.fixture
def store(tmp_path):
    job_store = JobStore(str(tmp_path / "jobs.db"), lambda: NOW)
    try:
        yield job_store
    finally:
        job_store.close()


def request(app, callback):
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://storage.test"
        ) as client:
            return await callback(client)

    return asyncio.run(run())


def assert_invalid_mutation_does_not_change_claimed_job(store, action, payload):
    app = create_storage_app(store, KEY)
    job = store.create(URL)
    claim = store.claim()

    async def mutate(client):
        return await client.post(
            f"/internal/jobs/{job.job_id}/{action}",
            headers={"X-Internal-Key": KEY},
            json={**payload, "lease_token": claim.lease_token},
        )

    rejected = request(app, mutate)
    assert rejected.status_code == 422

    async def fetch(client):
        return await client.get(
            f"/internal/jobs/{job.job_id}", headers={"X-Internal-Key": KEY}
        )

    current = request(app, fetch)
    assert current.status_code == 200
    assert current.json()["status"] == "running"
    assert store.get(job.job_id).lease_token == claim.lease_token


def test_private_job_routes_reject_missing_and_wrong_internal_key(store):
    app = create_storage_app(store, KEY)
    job = store.create(URL)
    claim = store.claim()
    cases = [
        ("post", "/internal/jobs", {"url": URL}),
        ("post", "/internal/jobs/claim", None),
        ("get", f"/internal/jobs/{job.job_id}", None),
        (
            "post",
            f"/internal/jobs/{job.job_id}/complete",
            {"lease_token": claim.lease_token, "listing": LISTING, "warnings": []},
        ),
        (
            "post",
            f"/internal/jobs/{job.job_id}/fail",
            {
                "lease_token": claim.lease_token,
                "code": "parse_failed",
                "message": "invalid listing",
                "transient": False,
            },
        ),
    ]

    async def exercise(client):
        statuses = []
        for method, path, payload in cases:
            missing = await client.request(method, path, json=payload)
            wrong = await client.request(
                method, path, headers={"X-Internal-Key": "wrong"}, json=payload
            )
            statuses.extend([missing.status_code, wrong.status_code])
        return statuses

    assert request(app, exercise) == [401] * 10


def test_create_claim_complete_and_get_returns_public_job_data(store):
    app = create_storage_app(store, KEY)
    headers = {"X-Internal-Key": KEY}

    async def exercise(client):
        created = await client.post(
            "/internal/jobs", headers=headers, json={"url": URL}
        )
        claimed = await client.post("/internal/jobs/claim", headers=headers)
        completed = await client.post(
            f"/internal/jobs/{created.json()['job_id']}/complete",
            headers=headers,
            json={
                "lease_token": claimed.json()["lease_token"],
                "listing": LISTING,
                "warnings": ["missing model"],
            },
        )
        fetched = await client.get(
            f"/internal/jobs/{created.json()['job_id']}", headers=headers
        )
        return created, claimed, completed, fetched

    created, claimed, completed, fetched = request(app, exercise)

    assert created.status_code == 201
    assert created.json()["status"] == "queued"
    assert claimed.status_code == 200
    assert claimed.json()["job_id"] == created.json()["job_id"]
    assert claimed.json()["source_url"] == URL
    assert claimed.json()["lease_token"]
    assert completed.status_code == 200
    assert completed.json() == {"updated": True}
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "completed"
    assert fetched.json()["listing"]["source_url"] == URL
    assert fetched.json()["listing"]["listing_id"] == "1"
    assert fetched.json()["listing"]["title"] == "Example car"
    assert fetched.json()["warnings"] == ["missing model"]
    assert fetched.json()["parsed_at"] == "2026-09-27T12:00:00Z"
    assert "lease_token" not in fetched.json()
    assert store.get(created.json()["job_id"]).lease_token is None


def test_complete_rejects_invalid_listing_without_mutating_job(store):
    assert_invalid_mutation_does_not_change_claimed_job(
        store, "complete", {"listing": {"source_url": URL}, "warnings": []}
    )


def test_fail_rejects_unknown_error_code_without_mutating_job(store):
    assert_invalid_mutation_does_not_change_claimed_job(
        store,
        "fail",
        {"code": "unknown_error", "message": "bad", "transient": False},
    )


def test_claim_returns_no_content_when_queue_is_empty(store):
    app = create_storage_app(store, KEY)

    async def exercise(client):
        return await client.post(
            "/internal/jobs/claim", headers={"X-Internal-Key": KEY}
        )

    response = request(app, exercise)

    assert response.status_code == 204
    assert response.content == b""


def test_fail_route_forwards_lease_and_persists_public_error(store):
    app = create_storage_app(store, KEY)
    job = store.create(URL)
    claim = store.claim()

    async def exercise(client):
        return await client.post(
            f"/internal/jobs/{job.job_id}/fail",
            headers={"X-Internal-Key": KEY},
            json={
                "lease_token": claim.lease_token,
                "code": "parse_failed",
                "message": "listing could not be parsed",
                "transient": False,
            },
        )

    response = request(app, exercise)

    assert response.status_code == 200
    assert response.json() == {"updated": True}
    failed = store.get(job.job_id)
    assert failed.status == "failed"
    assert failed.error_code == "parse_failed"
    assert failed.error_message == "listing could not be parsed"
    assert failed.lease_token is None


def test_health_is_available_without_internal_key(store):
    app = create_storage_app(store, KEY)

    async def exercise(client):
        return await client.get("/health")

    response = request(app, exercise)

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_runnable_lifespan_opens_and_closes_database_from_environment(
    tmp_path, monkeypatch
):
    db_path = tmp_path / "owned-jobs.db"
    monkeypatch.setenv("TURSO_DB_PATH", str(db_path))
    monkeypatch.setenv("INTERNAL_API_KEY", KEY)
    app = create_runnable_storage_app()

    async def run_lifespan():
        async with app.router.lifespan_context(app):
            owned_store = app.state.store
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://storage.test"
            ) as client:
                response = await client.post(
                    "/internal/jobs",
                    headers={"X-Internal-Key": KEY},
                    json={"url": URL},
                )
            return owned_store, response

    owned_store, response = asyncio.run(run_lifespan())

    assert response.status_code == 201
    assert db_path.is_file()
    with pytest.raises(RuntimeError, match="JobStore is closed"):
        owned_store.get(response.json()["job_id"])

    reopened = JobStore(str(db_path), lambda: NOW)
    try:
        assert reopened.get(response.json()["job_id"]).source_url == URL
    finally:
        reopened.close()


def test_runnable_lifespan_uses_default_path_and_creates_its_parent(
    tmp_path, monkeypatch
):
    default_path = tmp_path / "new-data" / "auto24.db"
    monkeypatch.delenv("TURSO_DB_PATH", raising=False)
    monkeypatch.setenv("INTERNAL_API_KEY", KEY)
    monkeypatch.setattr(storage_api, "DEFAULT_DB_PATH", str(default_path))
    app = create_runnable_storage_app()

    async def run_lifespan():
        async with app.router.lifespan_context(app):
            assert app.state.store is not None

    asyncio.run(run_lifespan())

    assert default_path.is_file()


def test_completed_job_returns_reveal_diagnostics(store):
    app = create_storage_app(store, KEY)
    job = store.create(URL)
    claim = store.claim()
    diagnostics = {
        "attempts": [
            {
                "attempt": 1,
                "started_at": "2026-09-27T12:00:00Z",
                "duration_ms": 900,
                "outcome": "no_captcha_needed",
            }
        ]
    }
    listing = {
        **LISTING,
        "registration": {"reg_number": "123ABC", "reg_number_status": "listed_in_full"},
    }

    async def flow(client):
        headers = {"X-Internal-Key": KEY}
        done = await client.post(
            f"/internal/jobs/{job.job_id}/complete",
            headers=headers,
            json={
                "lease_token": claim.lease_token,
                "listing": listing,
                "warnings": [],
                "reveal_diagnostics": diagnostics,
            },
        )
        assert done.json() == {"updated": True}
        return await client.get(f"/internal/jobs/{job.job_id}", headers=headers)

    body = request(app, flow).json()
    assert body["reveal_diagnostics"]["attempts"][0]["outcome"] == "no_captcha_needed"
    assert body["reveal_diagnostics"]["attempts"][0]["started_at"] == "2026-09-27T12:00:00Z"
    assert body["listing"]["registration"]["reg_number"] == "123ABC"
