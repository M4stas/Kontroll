from test_worker import FakeStorageClient, claimed_job, FIXTURE, LEASE_TOKEN, worker, parse_listing

class Client(FakeStorageClient):
    def __init__(self, outage=False):
        super().__init__(claimed_job())
        self.events, self.spans, self.outage = [], [], outage
    def record_spans(self, job_id, lease_token, spans, *, timeout):
        assert (job_id, lease_token, timeout) == ("job-1", LEASE_TOKEN, 1.0)
        self.events.append("spans")
        if self.outage: raise RuntimeError("storage unavailable")
        self.spans.extend(spans)
        return True
    def complete(self, *args):
        self.events.append("complete")
        return super().complete(*args)

def test_worker_records_parsing_and_flushes_before_complete():
    client = Client()
    worker.run_once(client, lambda url, observer: FIXTURE.read_text(), parse_listing, diagnostics_enabled=True)
    assert client.events[-1] == "complete"
    assert any(s.phase == "parsing" and s.state == "complete" for s in client.spans)

def test_worker_capture_result_identical_when_span_writes_fail():
    client = Client(outage=True)
    worker.run_once(client, lambda url, observer: FIXTURE.read_text(), parse_listing, diagnostics_enabled=True)
    reference = FakeStorageClient(claimed_job())
    worker.run_once(reference, lambda url: FIXTURE.read_text(), parse_listing)
    assert client.completed == reference.completed
    assert client.failed == []

def test_worker_without_diagnostics_never_calls_record_spans():
    client = Client()
    worker.run_once(client, lambda url: FIXTURE.read_text(), parse_listing)
    assert client.events == ["complete"]
