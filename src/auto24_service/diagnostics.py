"""Bounded, best-effort asynchronous capture timing collection."""
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from queue import Queue, Empty, Full
from threading import Condition, Thread
import time
from typing import ContextManager, Protocol
from uuid import uuid4
from auto24_service.contracts import CapturePhase, CaptureSpan


def utc_now():
    return datetime.now(timezone.utc)


class PhaseObserver(Protocol):
    def phase(self, name: CapturePhase) -> ContextManager[None]: ...


class _NullObserver:
    def phase(self, name: CapturePhase) -> ContextManager[None]:
        return nullcontext()


NULL_OBSERVER = _NullObserver()


class SpanRecorder:
    def __init__(self, write: Callable[[list[CaptureSpan]], bool], *, job_id, attempt,
                 monotonic=time.monotonic, now=utc_now, max_pending=64,
                 on_omitted: Callable[[int], bool] | None = None):
        self.job_id = job_id
        self.attempt = attempt
        self._write, self._monotonic, self._now = write, monotonic, now
        self._queue = Queue(maxsize=max_pending)
        self._condition = Condition()
        self._pending = 0
        self._closed = False
        self.omitted = 0
        self._on_omitted = on_omitted
        self._reported_omitted = 0
        Thread(target=self._drain, daemon=True).start()

    def _send(self, span):
        with self._condition:
            if self._closed:
                self.omitted += 1
                return
            try:
                self._queue.put_nowait(span)
            except Full:
                self.omitted += 1
            else:
                self._pending += 1

    @contextmanager
    def phase(self, name: CapturePhase) -> Iterator[None]:
        start = self._monotonic()
        span = CaptureSpan(span_id=str(uuid4()), attempt=self.attempt, phase=name,
                           state="running", started_at=self._now())
        self._send(span)
        state, error = "complete", None
        try:
            yield
        except BaseException:
            state, error = "failed", "phase_failed"
            raise
        finally:
            self._send(span.model_copy(update={"state": state, "error_code": error,
                "completed_at": self._now(),
                "duration_ms": max(0, (self._monotonic() - start) * 1000)}))

    def _drain(self):
        while True:
            with self._condition:
                if self._closed:
                    return
            try:
                batch = [self._queue.get(timeout=.01)]
            except Empty:
                self._report_omissions()
                continue
            while len(batch) < 16:
                try:
                    batch.append(self._queue.get_nowait())
                except Empty:
                    break
            with self._condition:
                if self._closed:
                    return
            try:
                accepted = self._write(batch)
            except Exception:
                accepted = False
            with self._condition:
                if not self._closed:
                    self._pending -= len(batch)
                    if not accepted:
                        self.omitted += len(batch)
                self._condition.notify_all()
            self._report_omissions()

    def _report_omissions(self):
        with self._condition:
            count = self.omitted
            if self._closed or self._on_omitted is None or count <= self._reported_omitted:
                return
        try:
            self._on_omitted(count)
        except Exception:
            pass
        finally:
            with self._condition:
                # One best-effort report per cumulative value; retain local counts
                # even when storage is unavailable, without retry loops.
                self._reported_omitted = count
                self._condition.notify_all()

    def flush(self, deadline_seconds: float = .1) -> None:
        deadline = time.monotonic() + max(0, deadline_seconds)
        with self._condition:
            while not self._closed and (self._pending or (
                self._on_omitted is not None and self._reported_omitted < self.omitted
            )):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._stop()
                    break
                self._condition.wait(remaining)

    def _stop(self):
        self._closed = True
        self.omitted += self._pending
        self._pending = 0
        while True:
            try:
                self._queue.get_nowait()
            except Empty:
                break
        self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._stop()
