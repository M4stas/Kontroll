import asyncio
from datetime import datetime, timedelta, timezone

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


# Background check routes. The store answers like the storage client, so tests pass it directly.
REG = {"reg_number": "123ABC", "reg_number_status": "revealed", "vin": "WVWZZZ1KZAW000001",
       "vin_status": "listed_in_full", "vin_format": "standard"}
PDF_BYTES = b"%PDF-1.7\nfake background check\n%%EOF\n"


class Clock:
    def __init__(self):
        self.value = NOW

    def __call__(self):
        return self.value


@pytest.fixture
def bg(tmp_path):
    from auto24_service.store import JobStore
    clock = Clock()
    store = JobStore(str(tmp_path / "bg.db"), clock)
    pdf_dir = tmp_path / "background-checks"
    pdf_dir.mkdir()
    app = create_public_app(store, KEY, background_check_dir=str(pdf_dir))
    try:
        yield store, clock, pdf_dir, app
    finally:
        store.close()


def completed(store, registration=REG):
    job = store.create(URL)
    claim = store.claim()
    listing = {"listing_id": "1"}
    if registration is not None:
        listing["registration"] = dict(registration)
    assert store.complete(job.job_id, claim.lease_token, listing, [])
    return job.job_id


def call(app, method, path, headers=None):
    async def exercise(client):
        return await client.request(method, path, headers={"X-API-Key": KEY} if headers is None else headers)
    return request(app, exercise)


def finish(store, job_id, **outcome):
    from auto24_service.store import BackgroundCheckFinish
    store.request_background_check(job_id)
    claim = store.claim_background_check()
    assert claim.job_id == job_id
    assert store.finish_background_check(job_id, claim.lease_token, BackgroundCheckFinish(**outcome))


def test_background_check_routes_require_the_api_key(bg):
    store, _, _, app = bg
    job_id = completed(store)
    routes = [("POST", f"/v1/jobs/{job_id}/background-check"),
              ("GET", f"/v1/jobs/{job_id}/background-check"),
              ("GET", f"/v1/jobs/{job_id}/background-check/pdf")]
    for method, path in routes:
        for headers in ({}, {"X-API-Key": "wrong"}):
            assert call(app, method, path, headers).status_code == 401
    assert store.background_check(job_id).status == "not_requested"


def test_post_starts_a_lookup_and_get_reads_it(bg):
    store, _, _, app = bg
    job_id = completed(store)
    assert call(app, "GET", f"/v1/jobs/{job_id}/background-check").json()["status"] == "not_requested"

    started = call(app, "POST", f"/v1/jobs/{job_id}/background-check")

    assert started.status_code == 202
    assert started.json() == {"status": "pending", "requested_at": "2026-09-27T12:00:00Z",
                              "searched_by": None, "reason": None, "fetched_at": None,
                              "size_bytes": None, "sha256": None}
    read = call(app, "GET", f"/v1/jobs/{job_id}/background-check")
    assert (read.status_code, read.json()) == (200, started.json())


def test_second_post_returns_the_same_lookup(bg):
    store, clock, _, app = bg
    job_id = completed(store)
    first = call(app, "POST", f"/v1/jobs/{job_id}/background-check")
    clock.value = NOW + timedelta(seconds=7)
    second = call(app, "POST", f"/v1/jobs/{job_id}/background-check")
    assert (second.status_code, second.json()) == (202, first.json())
    assert store.claim_background_check() is not None
    assert store.claim_background_check() is None


def test_post_refusals_answer_409(bg):
    store, _, _, app = bg
    old_job = completed(store, registration=None)
    pending = completed(store, {"reg_number": None, "reg_number_status": "pending", "vin": None,
                                "vin_status": "pending", "vin_format": None})
    store._db.execute("UPDATE jobs SET reveal_until = '2999-01-01T00:00:00.000000Z' WHERE job_id = ?", (pending,))
    store._db.commit()
    queued = store.create(URL).job_id
    for job_id in (queued, old_job, pending):
        response = call(app, "POST", f"/v1/jobs/{job_id}/background-check")
        assert response.status_code == 409
        assert "123ABC" not in response.text
        assert call(app, "GET", f"/v1/jobs/{job_id}/background-check").json()["status"] == "not_requested"


def test_unknown_job_answers_404_on_all_three_routes(bg):
    _, _, _, app = bg
    for method, suffix in (("POST", ""), ("GET", ""), ("GET", "/pdf")):
        assert call(app, method, f"/v1/jobs/missing/background-check{suffix}").status_code == 404


def test_get_reads_every_status_and_reason(bg):
    store, clock, pdf_dir, app = bg
    expected = {}
    job_id = completed(store, {"reg_number": None, "reg_number_status": "not_listed", "vin": None,
                               "vin_status": "unavailable", "vin_format": None})
    store.request_background_check(job_id)
    expected[job_id] = ("skipped", "no_identity", None)
    job_id = completed(store)
    finish(store, job_id, status="fetched", searched_by="reg_number", pdf_path=str(pdf_dir / "a.pdf"),
           size_bytes=10, sha256="b" * 64)
    expected[job_id] = ("fetched", None, "reg_number")
    job_id = completed(store)
    finish(store, job_id, status="not_found", searched_by="vin")
    expected[job_id] = ("not_found", None, "vin")
    for reason in ("captcha_failed", "blocked", "timeout", "pdf_rejected", "site_changed", "browser_crash"):
        job_id = completed(store)
        finish(store, job_id, status="unavailable", reason=reason, searched_by="reg_number")
        expected[job_id] = ("unavailable", reason, "reg_number")
    job_id = completed(store)
    store.request_background_check(job_id)
    expected[job_id] = ("pending", None, None)

    for job_id, (status, reason, searched_by) in expected.items():
        body = call(app, "GET", f"/v1/jobs/{job_id}/background-check").json()
        assert (body["status"], body["reason"], body["searched_by"]) == (status, reason, searched_by)
        assert (body["sha256"] is not None) == (status == "fetched")

    clock.value = NOW + timedelta(seconds=240)
    body = call(app, "GET", f"/v1/jobs/{job_id}/background-check").json()
    assert (body["status"], body["reason"]) == ("unavailable", "timeout")


def test_pdf_route_serves_the_fetched_file(bg):
    store, _, pdf_dir, app = bg
    job_id = completed(store)
    (pdf_dir / f"{job_id}.pdf").write_bytes(PDF_BYTES)
    finish(store, job_id, status="fetched", searched_by="reg_number",
           pdf_path=str(pdf_dir / f"{job_id}.pdf"), size_bytes=len(PDF_BYTES), sha256="c" * 64)

    response = call(app, "GET", f"/v1/jobs/{job_id}/background-check/pdf")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == PDF_BYTES


def test_pdf_route_answers_404_before_fetched_and_outside_the_directory(bg, tmp_path):
    store, _, pdf_dir, app = bg
    pending = completed(store)
    (pdf_dir / f"{pending}.pdf").write_bytes(PDF_BYTES)
    not_found = completed(store)
    finish(store, not_found, status="not_found", searched_by="reg_number")
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(PDF_BYTES)
    escaped = completed(store)
    finish(store, escaped, status="fetched", searched_by="reg_number",
           pdf_path=str(pdf_dir / ".." / "outside.pdf"), size_bytes=len(PDF_BYTES), sha256="d" * 64)
    missing = completed(store)
    finish(store, missing, status="fetched", searched_by="reg_number",
           pdf_path=str(pdf_dir / "gone.pdf"), size_bytes=len(PDF_BYTES), sha256="e" * 64)
    store.request_background_check(pending)

    for job_id in (pending, not_found, escaped, missing):
        response = call(app, "GET", f"/v1/jobs/{job_id}/background-check/pdf")
        assert response.status_code == 404
        assert PDF_BYTES not in response.content


@pytest.mark.parametrize("method, suffix", [("POST", ""), ("GET", ""), ("GET", "/pdf")])
def test_background_check_routes_answer_503_when_storage_is_down(method, suffix):
    class DownClient:
        def __getattr__(self, name):
            def fail(*_args):
                raise StorageUnavailableError("offline")
            return fail

    app = create_public_app(DownClient(), KEY)
    assert call(app, method, f"/v1/jobs/job-1/background-check{suffix}").status_code == 503
