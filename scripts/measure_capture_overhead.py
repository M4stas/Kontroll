"""Measure the wall-time overhead of Auto24 capture timing collection.

Runs worker.run_once against an in-process storage service over real HTTP, with a
fake browser capture that spends 1.0 s across the six browser phases and the real
parser on the passenger-car fixture. Five pairs alternate which run goes first.

Run: python scripts/measure_capture_overhead.py
"""

from __future__ import annotations

import json
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import uvicorn  # noqa: E402

from auto24_service.diagnostics import NULL_OBSERVER, PhaseObserver  # noqa: E402
from auto24_service.parser import parse_listing  # noqa: E402
from auto24_service.storage_api import create_storage_app  # noqa: E402
from auto24_service.storage_client import StorageClient  # noqa: E402
from auto24_service.store import JobStore  # noqa: E402
from auto24_service.worker import run_once  # noqa: E402

PAIRS = 5
LIMIT_MS = 500
KEY = "overhead-measurement-key"
LISTING_URL = "https://www.auto24.ee/soidukid/4344096"
HTML = (ROOT / "tests" / "fixtures" / "auto24-passenger-car.html").read_text(encoding="utf-8")
BROWSER_PHASES = (
    ("browser_start", 0.20),
    ("page_setup", 0.10),
    ("navigation", 0.40),
    ("html_retrieval", 0.10),
    ("validation", 0.05),
    ("browser_shutdown", 0.15),
)


def fake_capture(url: str, observer: PhaseObserver = NULL_OBSERVER) -> str:
    for phase, seconds in BROWSER_PHASES:
        with observer.phase(phase):
            time.sleep(seconds)
    return HTML


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def measure(diagnostics_enabled: bool) -> tuple[float, str, str, int]:
    with tempfile.TemporaryDirectory() as directory:
        store = JobStore(
            str(Path(directory) / "jobs.db"),
            lambda: datetime.now(timezone.utc),
            diagnostics_enabled=diagnostics_enabled,
        )
        port = free_port()
        server = uvicorn.Server(uvicorn.Config(create_storage_app(store, KEY), host="127.0.0.1", port=port, log_level="error"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        while not server.started:
            time.sleep(0.01)
        try:
            with StorageClient(f"http://127.0.0.1:{port}", KEY) as client:
                job = client.create(LISTING_URL)
                options = {"diagnostics_enabled": True} if diagnostics_enabled else {}
                started = time.perf_counter()
                run_once(client, fake_capture, parse_listing, **options)
                elapsed_ms = (time.perf_counter() - started) * 1000
                result = client.get(job.job_id)
                spans = client.diagnostics(job.job_id)
            listing = json.dumps(result.listing.model_dump(mode="json") if result.listing else None, sort_keys=True)
            return elapsed_ms, result.status, listing, len(spans.spans) if spans else 0
        finally:
            server.should_exit = True
            thread.join()
            store.close()


def main() -> int:
    measure(False)  # warm imports and the parser once before timing
    worst = 0.0
    identical = True
    print(f"{'pair':>4} {'order':<17} {'enabled ms':>10} {'disabled ms':>11} {'diff ms':>8} {'spans':>5} same")
    for pair in range(1, PAIRS + 1):
        order = (True, False) if pair % 2 else (False, True)
        runs = {enabled: measure(enabled) for enabled in order}
        on, off = runs[True], runs[False]
        difference = on[0] - off[0]
        same = on[1] == off[1] == "completed" and on[2] == off[2]
        worst = max(worst, difference)
        identical &= same
        label = "enabled first" if order[0] else "disabled first"
        print(f"{pair:>4} {label:<17} {on[0]:>10.1f} {off[0]:>11.1f} {difference:>8.1f} {on[3]:>5} {'yes' if same else 'NO'}")
    passed = worst <= LIMIT_MS and identical
    print(f"max difference: {worst:.1f} ms (limit {LIMIT_MS} ms)")
    print(f"identical outcomes: {'yes' if identical else 'no'}")
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
