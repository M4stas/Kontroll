from threading import Event

from fastapi.testclient import TestClient

from auto24_service.lookup_heartbeat import lookup_heartbeat
from auto24_service.storage_api import create_storage_app
from auto24_service.storage_client import StorageClient


def test_heartbeat_continues_while_main_thread_is_busy(monkeypatch):
    renewed = Event()
    calls = []

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def lookup_worker_heartbeat(self):
            calls.append(True)
            if len(calls) == 1:
                raise OSError('temporarily unavailable')
            renewed.set()

    monkeypatch.setattr('auto24_service.lookup_heartbeat.StorageClient', lambda *args: Client())
    with lookup_heartbeat('http://storage', 'test-key'):
        assert renewed.wait(7)
    assert len(calls) >= 2


def test_heartbeat_endpoint_requires_authentication_and_renews_store():
    class Store:
        heartbeats = 0

        def lookup_worker_heartbeat(self):
            self.heartbeats += 1

    store = Store()
    with TestClient(create_storage_app(store, 'test-key')) as api:
        assert api.post('/internal/background-checks/heartbeat').status_code == 401
        assert store.heartbeats == 0
        response = api.post('/internal/background-checks/heartbeat', headers={'X-Internal-Key': 'test-key'})
        assert response.status_code == 200
        assert store.heartbeats == 1


def test_storage_client_sends_authenticated_heartbeat():
    import httpx

    def handle(request):
        assert request.url.path == '/internal/background-checks/heartbeat'
        assert request.method == 'POST'
        assert request.headers['X-Internal-Key'] == 'test-key'
        return httpx.Response(200, json={'updated': True})

    with StorageClient('http://storage', 'test-key', transport=httpx.MockTransport(handle)) as client:
        client.lookup_worker_heartbeat()
