import httpx
import pytest

from auto24_service.storage_client import StorageClient, StorageUnavailableError


KEY = "client-test-secret"
JOB_RESPONSE = {
    "job_id": "job-1",
    "status": "queued",
    "submitted_at": "2026-09-27T12:00:00Z",
    "status_url": None,
    "parsed_at": None,
    "listing": None,
    "error": None,
    "warnings": [],
}
CLAIM_RESPONSE = {
    "job_id": "job-1",
    "source_url": "https://www.auto24.ee/soidukid/1",
    "attempts": 1,
    "lease_token": "lease-secret",
    "lease_until": "2026-09-27T12:02:00Z",
}
LISTING = {
    "source_url": "https://www.auto24.ee/soidukid/1",
    "listing_id": "1",
    "title": "Example car",
    "equipment": {},
    "technical_specs": {},
    "other_fields": {},
    "photo_urls": [],
}


def test_client_maps_storage_routes_payloads_and_return_values():
    requests = []

    def respond(request):
        requests.append(request)
        path = request.url.path
        if path == "/internal/jobs":
            return httpx.Response(201, json=JOB_RESPONSE)
        if path == "/internal/jobs/claim" and sum(
            item.url.path == path for item in requests
        ) == 1:
            return httpx.Response(200, json=CLAIM_RESPONSE)
        if path == "/internal/jobs/claim":
            return httpx.Response(204)
        if path.endswith("/complete") or path.endswith("/fail"):
            return httpx.Response(200, json={"updated": True})
        if path == "/internal/jobs/job-1":
            return httpx.Response(200, json=JOB_RESPONSE)
        if path == "/internal/jobs/missing":
            return httpx.Response(404)
        raise AssertionError(f"unexpected request: {request.method} {path}")

    with StorageClient(
        "http://storage.test", KEY, transport=httpx.MockTransport(respond)
    ) as client:
        created = client.create("https://www.auto24.ee/soidukid/1")
        claimed = client.claim()
        empty_claim = client.claim()
        completed = client.complete(
            "job-1", "lease-secret", LISTING, ["missing model"]
        )
        failed = client.fail(
            "job-1", "lease-secret", "parse_failed", "invalid listing", False
        )
        fetched = client.get("job-1")
        missing = client.get("missing")

    assert created.job_id == "job-1"
    assert claimed.job_id == "job-1"
    assert claimed.lease_token == "lease-secret"
    assert empty_claim is None
    assert completed is True
    assert failed is True
    assert fetched.job_id == "job-1"
    assert missing is None
    assert [(request.method, request.url.path) for request in requests] == [
        ("POST", "/internal/jobs"),
        ("POST", "/internal/jobs/claim"),
        ("POST", "/internal/jobs/claim"),
        ("POST", "/internal/jobs/job-1/complete"),
        ("POST", "/internal/jobs/job-1/fail"),
        ("GET", "/internal/jobs/job-1"),
        ("GET", "/internal/jobs/missing"),
    ]
    assert all(request.headers["X-Internal-Key"] == KEY for request in requests)
    assert requests[0].read() == b'{"url":"https://www.auto24.ee/soidukid/1"}'
    assert requests[3].read() == (
        b'{"lease_token":"lease-secret","listing":'
        b'{"source_url":"https://www.auto24.ee/soidukid/1","listing_id":"1",'
        b'"title":"Example car","equipment":{},"technical_specs":{},'
        b'"other_fields":{},"photo_urls":[]},"warnings":["missing model"]}'
    )
    assert requests[4].read() == (
        b'{"lease_token":"lease-secret","code":"parse_failed",'
        b'"message":"invalid listing","transient":false}'
    )


def test_client_sends_a_bounded_request_timeout():
    observed = []

    def respond(request):
        observed.append(request.extensions["timeout"])
        return httpx.Response(200, json=JOB_RESPONSE)

    with StorageClient(
        "http://storage.test", KEY, transport=httpx.MockTransport(respond)
    ) as client:
        client.get("job-1")

    assert observed == [{"connect": 5.0, "read": 5.0, "write": 5.0, "pool": 5.0}]


@pytest.mark.parametrize(
    "failure", [httpx.ConnectError("offline"), httpx.ReadTimeout("timed out")]
)
def test_client_maps_transport_unavailability_and_timeouts(failure):
    def fail(request):
        if isinstance(failure, httpx.ConnectError):
            raise httpx.ConnectError(str(failure), request=request)
        raise httpx.ReadTimeout(str(failure), request=request)

    with StorageClient(
        "http://storage.test", KEY, transport=httpx.MockTransport(fail)
    ) as client:
        with pytest.raises(StorageUnavailableError):
            client.get("job-1")


def test_client_maps_storage_server_errors_to_unavailable():
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    with StorageClient("http://storage.test", KEY, transport=transport) as client:
        with pytest.raises(StorageUnavailableError):
            client.create("https://www.auto24.ee/soidukid/1")


def test_client_sends_reveal_diagnostics():
    import json

    from auto24_service.contracts import AttemptRecord, RevealDiagnostics

    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"updated": True})

    diagnostics = RevealDiagnostics(
        attempts=[
            AttemptRecord(
                attempt=1,
                started_at="2026-09-27T12:00:00Z",
                duration_ms=10,
                outcome="no_captcha_needed",
            )
        ]
    )
    with StorageClient(
        "http://storage.test", KEY, transport=httpx.MockTransport(respond)
    ) as client:
        assert client.complete("job-1", "lease-secret", LISTING, [], diagnostics)

    sent = json.loads(requests[0].read())
    assert sent["reveal_diagnostics"] == diagnostics.model_dump(mode="json")


def test_storage_client_record_spans_uses_short_timeout():
    observed = []
    def respond(request):
        observed.append(request)
        return httpx.Response(200, json={'updated': True})
    with StorageClient('http://storage.test', KEY, transport=httpx.MockTransport(respond)) as client:
        assert client.record_spans('job-1', 'secret', [], timeout=0.25)
    assert observed[0].extensions['timeout'] == dict.fromkeys(('connect', 'read', 'write', 'pool'), 0.25)
    assert observed[0].url.path == '/internal/jobs/job-1/diagnostics'
    assert observed[0].read() == b'{"lease_token":"secret","spans":[]}'


def test_storage_client_diagnostics_reads_and_maps_missing():
    def respond(request):
        if 'missing' in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, json={'job_id': 'job-1', 'collection': 'disabled', 'spans': [], 'omitted': 0})
    with StorageClient('http://storage.test', KEY, transport=httpx.MockTransport(respond)) as client:
        assert client.diagnostics('job-1').collection == 'disabled'
        assert client.diagnostics('missing') is None


def test_client_set_registration_round_trip(tmp_path):
    from datetime import datetime, timezone

    from auto24_service.contracts import Registration
    from auto24_service.storage_api import create_storage_app
    from auto24_service.store import JobStore

    now = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: now)
    app = create_storage_app(store, KEY)

    class AsgiBridge(httpx.BaseTransport):
        def handle_request(self, request):
            import asyncio

            async def run():
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://storage.test"
                ) as inner:
                    return await inner.request(
                        request.method,
                        request.url.path,
                        headers=request.headers,
                        content=request.content,
                    )

            result = asyncio.run(run())
            return httpx.Response(result.status_code, headers=result.headers, content=result.content)

    final = Registration(
        reg_number="123ABC",
        reg_number_status="revealed",
        vin="WVWZZZ1KZAW000001",
        vin_status="revealed",
        vin_format="standard",
    )
    pending_listing = {**LISTING, "registration": Registration.pending().model_dump(mode="json")}
    try:
        with StorageClient("http://storage.test", KEY, transport=AsgiBridge()) as client:
            job = client.create("https://www.auto24.ee/soidukid/1")
            claim = client.claim()
            assert client.complete(
                job.job_id, claim.lease_token, pending_listing, [], reveal_token="rt-1"
            )
            assert client.get(job.job_id).listing.registration.vin_status == "pending"

            assert client.set_registration(job.job_id, "rt-1", final, None)
            registration = client.get(job.job_id).listing.registration
            assert registration.reg_number == "123ABC"
            assert registration.reg_number_status == "revealed"
            assert registration.vin_status == "revealed"
            assert not client.set_registration(job.job_id, "rt-1", final, None)
    finally:
        store.close()
