import threading
import time
from datetime import datetime, timezone
import pytest
from auto24_service.diagnostics import SpanRecorder


def test_phase_records_running_then_complete_with_monotonic_duration():
    spans = []
    ticks = iter([1.0, 1.25])
    recorder = SpanRecorder(lambda batch: spans.extend(batch) or True, job_id="job", attempt=1, monotonic=lambda: next(ticks))
    with recorder.phase("parsing"):
        pass
    recorder.flush()
    recorder.close()
    assert [s.state for s in spans] == ["running", "complete"]
    assert spans[0].span_id == spans[1].span_id
    assert spans[1].duration_ms == 250


def test_phase_marks_failed_and_reraises_original_error():
    spans = []
    recorder = SpanRecorder(lambda batch: spans.extend(batch) or True, job_id="job", attempt=1)
    error = ValueError("original")
    with pytest.raises(ValueError) as raised:
        with recorder.phase("navigation"):
            raise error
    recorder.flush()
    recorder.close()
    assert raised.value is error
    assert spans[-1].state == "failed"
    assert spans[-1].error_code == "phase_failed"


def test_write_runs_off_the_calling_thread_and_flush_is_bounded():
    release = threading.Event()
    entered = threading.Event()
    threads = []
    def write(batch):
        threads.append(threading.get_ident())
        entered.set()
        release.wait(1)
        return True
    recorder = SpanRecorder(write, job_id="job", attempt=1)
    start = time.monotonic()
    with recorder.phase("parsing"):
        pass
    assert time.monotonic() - start < .05
    assert entered.wait(.1)
    start = time.monotonic()
    recorder.flush(.1)
    assert time.monotonic() - start < .15
    assert recorder.omitted > 0
    recorder.close()
    release.set()
    assert threads == [threads[0]]
    assert threads[0] != threading.get_ident()


def test_writer_exception_never_reaches_caller():
    def write(batch):
        raise RuntimeError("down")
    recorder = SpanRecorder(write, job_id="job", attempt=1)
    with recorder.phase("parsing"):
        pass
    recorder.flush()
    recorder.close()
    assert recorder.omitted == 2


def test_queue_full_drops_and_counts():
    release = threading.Event()
    recorder = SpanRecorder(lambda batch: release.wait(1), job_id="job", attempt=1, max_pending=1)
    for _ in range(20):
        with recorder.phase("parsing"):
            pass
    recorder.flush(0)
    recorder.close()
    release.set()
    assert recorder.omitted > 0
