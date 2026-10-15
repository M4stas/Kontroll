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
