"""Advertise lookup capacity independently of browser work."""

from contextlib import contextmanager
from threading import Event, Thread

from .storage_client import StorageClient


@contextmanager
def lookup_heartbeat(storage_url: str, internal_key: str):
    stopped = Event()

    def send():
        with StorageClient(storage_url, internal_key) as client:
            while not stopped.is_set():
                try:
                    client.lookup_worker_heartbeat()
                except Exception:
                    pass
                if stopped.wait(5):
                    break

    thread = Thread(target=send, name="lookup-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=6)
