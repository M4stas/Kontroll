from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from contextlib import contextmanager
import hashlib

from auto24_service.browser import CaptureError, CaptureResult
from auto24_service.captcha.reveal import RevealOutcome
from auto24_service.contracts import AttemptRecord, Registration, RevealDiagnostics
from auto24_service.parser import parse_listing
from auto24_service.store import ClaimedJob, JobStore
import auto24_service.worker as worker


LISTING_URL = "https://www.auto24.ee/soidukid/4344096"
LEASE_TOKEN = "lease-token-1"
LEASE_UNTIL = datetime(2026, 9, 27, 12, 2, tzinfo=timezone.utc)
FIXTURE = Path(__file__).parent / "fixtures" / "auto24-passenger-car.html"


def captured(html):
    return CaptureResult(html=html, registration=None, reveal_diagnostics=None)


def completing(on_html, html, registration=None, reveal_diagnostics=None):
    """Act like capture_listing: hand over the HTML, then reveal only if the job completed."""
    if not on_html(html):
        return captured(html)
    return CaptureResult(html=html, registration=registration, reveal_diagnostics=reveal_diagnostics)


def fixture_capture(_url, *, on_html, **_kw):
    return completing(on_html, FIXTURE.read_text(encoding="utf-8"))


def claimed_job() -> ClaimedJob:
    return ClaimedJob(
        job_id="job-1",
        source_url=LISTING_URL,
        attempts=1,
        lease_token=LEASE_TOKEN,
        lease_until=LEASE_UNTIL,
    )


class FakeStorageClient:
    def __init__(self, claim):
        self.claimed = claim
        self.completed = []
        self.failed = []
        self.reveal_tokens = []
        self.registrations = []
        self.calls = []
        self.complete_result = True

    def claim(self):
        claim, self.claimed = self.claimed, None
        return claim

    def complete(self, job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, reveal_token=None):
        self.calls.append("complete")
        self.completed.append((job_id, lease_token, listing, warnings))
        self.reveal_tokens.append(reveal_token)
        self.diagnostics = reveal_diagnostics
        return self.complete_result

    def set_registration(self, job_id, reveal_token, registration, reveal_diagnostics):
        self.calls.append("set_registration")
        self.registrations.append((job_id, reveal_token, registration))
        self.diagnostics = reveal_diagnostics
        return True

    def fail(self, job_id, lease_token, code, message, transient):
        self.failed.append((job_id, lease_token, code, message, transient))
        return True


def test_run_once_parses_and_completes_claimed_job_with_lease_token():
    client = FakeStorageClient(claimed_job())

    processed = worker.run_once(
        client,
        fixture_capture,
        parse_listing,
    )

    assert processed is True
    assert client.completed[0][0:2] == ("job-1", LEASE_TOKEN)
    assert client.completed[0][2]["listing_id"] == "4344096"
    assert client.completed[0][2]["title"] == "Skoda Enyaq 195kW"
    assert client.completed[0][3] == []
    assert client.failed == []


def test_run_once_returns_false_without_capturing_when_queue_is_empty():
    client = FakeStorageClient(None)

    processed = worker.run_once(
        client,
        lambda _url, **_kw: (_ for _ in ()).throw(AssertionError("captured without a job")),
        parse_listing,
    )

    assert processed is False
    assert client.completed == []
    assert client.failed == []


def test_browser_timeout_is_recorded_as_retryable_temporary_failure():
    client = FakeStorageClient(claimed_job())

    def timeout(_url, **_kw):
        raise CaptureError("temporary_failure")

    assert worker.run_once(client, timeout, parse_listing) is True
    assert client.completed == []
    assert client.failed[0][0:3] == ("job-1", LEASE_TOKEN, "temporary_failure")
    assert client.failed[0][4] is True


def test_retryable_failure_log_does_not_claim_terminal_status(tmp_path, caplog):
    now = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: now)
    try:
        created = store.create(LISTING_URL)

        class StoreBackedClient:
            def claim(self):
                return store.claim()

            def complete(self, job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, reveal_token=None):
                return store.complete(job_id, lease_token, listing, warnings, reveal_token=reveal_token)

            def fail(self, job_id, lease_token, code, message, transient):
                return store.fail(job_id, lease_token, code, message, transient)

        def timeout(_url, **_kw):
            raise CaptureError("temporary_failure")

        with caplog.at_level(logging.WARNING, logger=worker.__name__):
            assert worker.run_once(StoreBackedClient(), timeout, parse_listing) is True

        saved = store.get(created.job_id)
        assert saved.status == "queued"
        assert saved.error_code == "temporary_failure"
        assert "action=failure_recorded" in caplog.text
        assert "status=failed" not in caplog.text
    finally:
        store.close()


def test_parse_failure_is_recorded_as_terminal():
    client = FakeStorageClient(claimed_job())

    def capture(_url, *, on_html, **_kw):
        return completing(on_html, "<main>not a listing</main>")

    assert worker.run_once(client, capture, parse_listing) is True
    assert client.completed == []
    assert client.failed[0][0:3] == ("job-1", LEASE_TOKEN, "parse_failed")
    assert client.failed[0][4] is False


def test_successful_worker_run_persists_snapshot_with_utc_parsed_at(tmp_path):
    parsed_at = datetime(2026, 9, 27, 12, 0, 15, tzinfo=timezone.utc)
    store = JobStore(str(tmp_path / "jobs.db"), lambda: parsed_at)
    try:
        created = store.create(LISTING_URL)

        class StoreBackedClient:
            def claim(self):
                return store.claim()

            def complete(self, job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, reveal_token=None):
                return store.complete(job_id, lease_token, listing, warnings, reveal_token=reveal_token)

            def fail(self, job_id, lease_token, code, message, transient):
                return store.fail(job_id, lease_token, code, message, transient)

        assert worker.run_once(
            StoreBackedClient(),
            fixture_capture,
            parse_listing,
        ) is True

        saved = store.get(created.job_id)
        assert saved.status == "completed"
        assert saved.parsed_at == parsed_at
        assert saved.parsed_at.isoformat().replace("+00:00", "Z") == "2026-09-27T12:00:15Z"
        assert saved.listing["listing_id"] == "4344096"
    finally:
        store.close()


def test_run_forever_waits_two_seconds_after_an_empty_claim(monkeypatch):
    calls = []
    sleeps = []

    class StopLoop(Exception):
        pass

    def stop_after_one_empty_claim(*_args):
        calls.append(True)
        if len(calls) > 1:
            raise StopLoop
        return False

    monkeypatch.setattr(worker, "run_once", stop_after_one_empty_claim)
    monkeypatch.setattr(worker.time, "sleep", sleeps.append)

    with pytest.raises(StopLoop):
        worker.run_forever(object(), None, None)

    assert calls == [True, True]
    assert sleeps == [2]


def test_main_once_uses_configured_storage_client_and_closes_it(monkeypatch):
    observed = {}

    class Client:
        def __init__(self, base_url, internal_key):
            observed["config"] = (base_url, internal_key)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            observed["closed"] = True

    def process_once(client, capture_html, parser):
        observed["once"] = (client, capture_html, parser)
        return True

    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setattr(worker, "StorageClient", Client)
    monkeypatch.setattr(worker, "run_once", process_once)
    solver = install_fake_solver(monkeypatch, observed)

    assert worker.main(["--once"]) == 0

    assert observed["config"] == ("http://127.0.0.1:8001", "private-key")
    assert observed["verified"] == Path("/opt/captcha-solver")
    assert observed["loaded"] == [Path("/opt/captcha-solver")]
    capture = observed["once"][1]
    assert capture.func is worker.capture_listing
    assert capture.keywords == {"solver": solver, "force_failure": False}
    assert observed["once"][2] is worker.parse_listing
    assert observed["closed"] is True


def install_fake_solver(monkeypatch, observed):
    solver = object()

    def verify(solver_dir):
        observed["verified"] = solver_dir

    def load(solver_dir, use_lookup=False):
        observed.setdefault("loaded", []).append(solver_dir)
        return solver

    monkeypatch.delenv("AUTO24_ENV", raising=False)
    monkeypatch.delenv("REVEAL_FORCE_FAILURE", raising=False)
    monkeypatch.delenv("CAPTCHA_SOLVER_DIR", raising=False)
    monkeypatch.setattr(worker, "verify_solver_dir", verify)
    monkeypatch.setattr(worker, "load_solver", load)
    return solver


def revealed_registration():
    return Registration(
        reg_number="123ABC",
        reg_number_status="revealed",
        vin="WVWZZZ1KZAW000001",
        vin_status="revealed",
        vin_format="standard",
    )


def test_worker_merges_registration_into_listing_and_stores_diagnostics(caplog):
    client = FakeStorageClient(claimed_job())
    diagnostics = RevealDiagnostics(
        attempts=[
            AttemptRecord(
                attempt=1,
                started_at=LEASE_UNTIL,
                duration_ms=10,
                outcome="revealed",
            )
        ]
    )

    def capture(_url, *, on_html, **_kw):
        return completing(on_html, FIXTURE.read_text(encoding="utf-8"), revealed_registration(), diagnostics)

    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True

    assert client.completed[0][2]["registration"]["reg_number_status"] == "pending"
    [(_job_id, _token, registration)] = client.registrations
    assert registration.reg_number == "123ABC"
    assert registration.vin_status == "revealed"
    assert client.diagnostics == diagnostics
    assert "job-1" in caplog.text
    assert "reg_number_status=revealed" in caplog.text
    assert "123ABC" not in caplog.text
    assert "WVWZZZ1KZAW000001" not in caplog.text


def test_worker_logs_initial_rejected_field_names_only(caplog):
    client = FakeStorageClient(claimed_job())
    registration = Registration(
        reg_number=None, reg_number_status="unavailable", vin=None, vin_status="not_listed", vin_format=None
    )
    diagnostics = RevealDiagnostics(initial_rejected=["reg_number"])

    def capture(_url, *, on_html, **_kw):
        return completing(on_html, FIXTURE.read_text(encoding="utf-8"), registration, diagnostics)

    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True
    assert "initial_rejected=reg_number" in caplog.text
    assert "N/A" not in caplog.text
    assert client.diagnostics.initial_rejected == ["reg_number"]


class FakePage:
    def content(self):
        return FIXTURE.read_text(encoding="utf-8")


def test_reveal_exception_completes_job_with_browser_error():
    client = FakeStorageClient(claimed_job())
    events = []

    @contextmanager
    def opener(url, *, profile_dir=None):
        events.append("open")
        try:
            yield SimpleNamespace(page=FakePage(), main_frame_blocked=False, blocked=[])
        finally:
            events.append("close")

    def reveal(*_args, **_kwargs):
        raise RuntimeError("boom")

    def capture(url, *, on_html, **_kw):
        return worker.capture_listing(url, solver=object(), opener=opener, reveal=reveal, on_html=on_html)

    assert worker.run_once(client, capture, parse_listing) is True

    assert events == ["open", "close"]
    assert client.failed == []
    [(_job_id, _token, registration)] = client.registrations
    assert registration.reg_number_status == "unavailable"
    assert registration.vin_status == "unavailable"
    assert registration.reg_number is None and registration.vin is None
    [attempt] = client.diagnostics.attempts
    assert (attempt.outcome, attempt.reason) == ("failed", "browser_error")
    assert attempt.error_type == "RuntimeError"
    assert "boom" not in client.diagnostics.model_dump_json()


@pytest.mark.parametrize(
    "code", ["listing_gone", "access_blocked", "temporary_failure"]
)
def test_capture_errors_still_fail_the_job_as_before(code):
    client = FakeStorageClient(claimed_job())

    @contextmanager
    def opener(url, *, profile_dir=None):
        raise CaptureError(code)
        yield

    def capture(url, **_kw):
        return worker.capture_listing(url, solver=object(), opener=opener)

    assert worker.run_once(client, capture, parse_listing) is True
    assert client.completed == []
    assert client.failed[0][2] == code
    assert client.failed[0][4] is (code == "temporary_failure")


def test_capture_listing_reports_a_challenge_page_before_revealing():
    @contextmanager
    def opener(url, *, profile_dir=None):
        page = SimpleNamespace(content=lambda: "<p>Verify you are human</p>")
        yield SimpleNamespace(page=page, main_frame_blocked=False, blocked=[])

    def reveal(*_args, **_kwargs):
        raise AssertionError("revealed on a challenge page")

    with pytest.raises(CaptureError) as error:
        worker.capture_listing(LISTING_URL, solver=object(), opener=opener, reveal=reveal)
    assert error.value.code == "access_blocked"


def test_capture_listing_forwards_its_deadline_to_the_reveal():
    seen = {}

    @contextmanager
    def opener(url, *, profile_dir=None):
        yield SimpleNamespace(page=FakePage(), main_frame_blocked=False, blocked=[])

    def reveal(*_args, **kwargs):
        seen.update(kwargs)
        raise RuntimeError("stop here")

    worker.capture_listing(
        LISTING_URL, solver=object(), opener=opener, reveal=reveal, deadline=1234.5
    )
    assert seen["deadline"] == 1234.5


def test_worker_rejects_bad_lookup_setting(monkeypatch, capsys):
    install_fake_solver(monkeypatch, {})
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", "maybe")

    with pytest.raises(SystemExit) as exit_info:
        worker.main(["--once"])

    assert exit_info.value.code == 2
    assert "CAPTCHA_LOOKUP_ENABLED" in capsys.readouterr().err


def test_worker_loads_solver_with_lookup_off_by_default_and_on_when_set(monkeypatch):
    seen = []
    install_fake_solver(monkeypatch, {})
    monkeypatch.setattr(worker, "load_solver", lambda d, use_lookup=False: seen.append(use_lookup) or object())
    monkeypatch.setattr(worker, "StorageClient", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("stop")))
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    for value in (None, "true"):
        if value is None:
            monkeypatch.delenv("CAPTCHA_LOOKUP_ENABLED", raising=False)
        else:
            monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", value)
        with pytest.raises(RuntimeError):
            worker.main(["--once"])
    assert seen == [False, True]


def test_worker_refuses_force_failure_outside_development(monkeypatch, capsys):
    install_fake_solver(monkeypatch, {})
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setenv("REVEAL_FORCE_FAILURE", "true")
    monkeypatch.setenv("AUTO24_ENV", "production")

    with pytest.raises(SystemExit) as exit_info:
        worker.main(["--once"])

    assert exit_info.value.code == 2
    message = capsys.readouterr().err
    assert "REVEAL_FORCE_FAILURE" in message and "AUTO24_ENV" in message


def test_worker_refuses_force_failure_when_env_is_unset(monkeypatch):
    install_fake_solver(monkeypatch, {})
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setenv("REVEAL_FORCE_FAILURE", "true")

    with pytest.raises(SystemExit) as exit_info:
        worker.main(["--once"])
    assert exit_info.value.code == 2


def test_worker_allows_force_failure_in_test_env(monkeypatch):
    observed = {}

    class Client:
        def __init__(self, *_args):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    install_fake_solver(monkeypatch, observed)
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setenv("REVEAL_FORCE_FAILURE", "true")
    monkeypatch.setenv("AUTO24_ENV", "test")
    monkeypatch.setenv("CAPTCHA_SOLVER_DIR", "/srv/solver")
    monkeypatch.setattr(worker, "StorageClient", Client)
    monkeypatch.setattr(
        worker, "run_once", lambda _c, capture, _p: observed.setdefault("capture", capture)
    )

    assert worker.main(["--once"]) == 0
    assert observed["capture"].keywords["force_failure"] is True
    assert observed["loaded"] == [Path("/srv/solver")]


SOLVER_NAMES = ("type.onnx", "grid.onnx", "grid.meta.json", "captcha.sqlite")


def write_solver_dir(tmp_path, monkeypatch):
    """Write four stand-in solver files and pin their hashes for this test."""
    from auto24_service.captcha import assets

    solver_dir = tmp_path / "solver"
    solver_dir.mkdir()
    pinned = {}
    for name in SOLVER_NAMES:
        (solver_dir / name).write_bytes(name.encode())
        pinned[name] = hashlib.sha256(name.encode()).hexdigest()
    (solver_dir / "SHA256SUMS").write_text(
        "".join(f"{digest}  {name}\n" for name, digest in pinned.items())
    )
    monkeypatch.setattr(assets, "PINNED_SOLVER_SHA256", pinned)
    return solver_dir


def run_main_expecting_exit_2(monkeypatch, capsys, solver_dir, load=None):
    monkeypatch.setenv("STORAGE_URL", "http://127.0.0.1:8001")
    monkeypatch.setenv("INTERNAL_API_KEY", "private-key")
    monkeypatch.setenv("CAPTCHA_SOLVER_DIR", str(solver_dir))
    monkeypatch.delenv("REVEAL_FORCE_FAILURE", raising=False)
    monkeypatch.setattr(
        worker, "load_solver", load or (lambda _d, use_lookup=False: (_ for _ in ()).throw(AssertionError("loaded")))
    )
    monkeypatch.setattr(
        worker, "StorageClient", lambda *_a: (_ for _ in ()).throw(AssertionError("started"))
    )
    with pytest.raises(SystemExit) as exit_info:
        worker.main(["--once"])
    assert exit_info.value.code == 2
    return capsys.readouterr().err


@pytest.mark.parametrize(
    ("damage", "message"),
    [
        ("missing", "grid.onnx"),
        ("mismatch", "grid.onnx"),
        ("empty_sums", "SHA256SUMS"),
        ("partial_sums", "SHA256SUMS"),
        ("no_sums_missing_file", "captcha.sqlite"),
        ("malformed_sums", "malformed line 1"),
    ],
)
def test_worker_refuses_to_start_when_solver_files_fail_verification(
    monkeypatch, tmp_path, capsys, damage, message
):
    solver_dir = write_solver_dir(tmp_path, monkeypatch)
    sums = solver_dir / "SHA256SUMS"
    if damage == "missing":
        (solver_dir / "grid.onnx").unlink()
    elif damage == "mismatch":
        (solver_dir / "grid.onnx").write_bytes(b"tampered")
    elif damage == "empty_sums":
        sums.write_text("")
    elif damage == "partial_sums":
        sums.write_text(sums.read_text().splitlines()[0] + "\n")
    elif damage == "no_sums_missing_file":
        sums.unlink()
        (solver_dir / "captcha.sqlite").unlink()
    else:
        sums.write_text("not-a-valid-line\n")

    err = run_main_expecting_exit_2(monkeypatch, capsys, solver_dir)

    assert message in err
    assert "Traceback" not in err


def test_worker_exits_2_when_the_solver_fails_to_load(monkeypatch, tmp_path, capsys):
    solver_dir = write_solver_dir(tmp_path, monkeypatch)

    def broken(_d, use_lookup=False):
        raise RuntimeError("bad model graph")

    err = run_main_expecting_exit_2(monkeypatch, capsys, solver_dir, load=broken)

    assert "could not be loaded" in err and "bad model graph" in err
    assert "Traceback" not in err


def test_verify_solver_dir_accepts_matching_files(tmp_path, monkeypatch):
    from auto24_service.captcha.assets import verify_solver_dir

    solver_dir = write_solver_dir(tmp_path, monkeypatch)
    verify_solver_dir(solver_dir)
    (solver_dir / "SHA256SUMS").unlink()
    verify_solver_dir(solver_dir)


def test_capture_budget_leaves_room_to_complete_the_job_inside_the_lease(tmp_path, monkeypatch):
    # The store's clock and the worker's wall clock are one fake clock. The capture
    # spends its whole deadline (a reveal that hits every timeout), and the job must
    # still complete instead of being reclaimed as superseded.
    now = {"t": datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)}
    store = JobStore(str(tmp_path / "jobs.db"), lambda: now["t"])
    monkeypatch.setattr(worker, "_utcnow", lambda: now["t"])
    try:
        created = store.create(LISTING_URL)

        class StoreBackedClient:
            def claim(self):
                return store.claim()

            def complete(self, job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, reveal_token=None):
                return store.complete(job_id, lease_token, listing, warnings, reveal_token=reveal_token)

            def fail(self, job_id, lease_token, code, message, transient):
                return store.fail(job_id, lease_token, code, message, transient)

        seen = {}

        def slow_capture(_url, *, deadline, on_html):
            budget = deadline - worker.time.monotonic()
            seen["budget"] = budget
            now["t"] += timedelta(seconds=budget)
            return completing(on_html, FIXTURE.read_text(encoding="utf-8"))

        assert worker.run_once(StoreBackedClient(), slow_capture, parse_listing) is True

        assert 100 <= seen["budget"] <= 105
        saved = store.get(created.job_id)
        assert saved.status == "completed"
        assert saved.attempts == 1
    finally:
        store.close()


def test_capture_listing_saves_html_before_any_click(monkeypatch):
    pytest.importorskip("camoufox.sync_api")
    from auto24_service import browser
    from fakesite import LISTING_URL as FAKE_URL, Scenario, install_fake_site

    real_open = browser.open_listing

    def open_fake(url, *, profile_dir=None):
        return real_open(url, setup=lambda c: install_fake_site(c, Scenario()), profile_dir=profile_dir)

    monkeypatch.setattr(browser, "open_listing", open_fake)

    result = browser.capture_listing(FAKE_URL, solver=object(), force_failure=True)

    assert "näita reg. nr." in result.html
    # No reCAPTCHA widget yet: the page script mentions grecaptcha, but no widget
    # row or api.js tag is inserted until a trigger is clicked.
    assert "cptch-wrapper" not in result.html
    assert "recaptcha/api.js" not in result.html
    assert result.registration.reg_number_status == "unavailable"
    assert [a.reason for a in result.reveal_diagnostics.attempts] == [
        "widget_not_found",
        "widget_not_found",
    ]


@pytest.mark.parametrize('value, expected', [(None, 'camoufox'), ('camoufox', 'camoufox'), ('chromium', 'chromium')])
def test_parse_capture_engine(value, expected):
    assert worker.parse_capture_engine(value) == expected


@pytest.mark.parametrize('value', ['firefox', '', ' Chromium ', 'x'])
def test_parse_capture_engine_rejects_unknown(value):
    with pytest.raises(ValueError):
        worker.parse_capture_engine(value)


def test_worker_refuses_unknown_engine(monkeypatch, capsys):
    monkeypatch.setenv('CAPTURE_ENGINE', 'x')
    with pytest.raises(SystemExit) as exc:
        worker.main(['--once'])
    assert exc.value.code == 2
    assert 'CAPTURE_ENGINE' in capsys.readouterr().err


def test_chromium_engine_wires_the_chromium_opener(monkeypatch):
    monkeypatch.setenv('CHROMIUM_WARM_PROFILE', 'false')
    import auto24_service.browser_chromium as chromium
    observed = []
    monkeypatch.setenv('CAPTURE_ENGINE', 'chromium')
    monkeypatch.setenv('STORAGE_URL', 'http://127.0.0.1:8001')
    monkeypatch.setenv('INTERNAL_API_KEY', 'test-key')
    monkeypatch.setenv('CAPTCHA_LOOKUP_ENABLED', 'invalid')
    monkeypatch.setattr(worker, 'verify_solver_dir', lambda *a: pytest.fail('verified Python solver'))
    monkeypatch.setattr(worker, 'load_solver', lambda *a, **kw: pytest.fail('loaded Python solver'))
    monkeypatch.setattr(chromium, 'sweep_leftovers', lambda root: observed.append(('sweep', root)))
    class Client:
        def __init__(self, *a): pass
        def __enter__(self): return self
        def __exit__(self, *a): pass
    monkeypatch.setattr(worker, 'StorageClient', Client)
    monkeypatch.setattr(worker, 'run_once', lambda client, capture, parser: observed.append(('capture', capture)))
    assert worker.main(['--once']) == 0
    import tempfile
    assert observed[0] == ('sweep', Path(tempfile.gettempdir()))
    capture = observed[1][1]
    assert capture.keywords['opener'] is chromium.open_chromium_listing
    from auto24_service.captcha.extension_wait import EXTENSION
    from auto24_service.captcha.reveal import reveal_registration
    assert capture.keywords['reveal'] is reveal_registration
    assert capture.keywords['solver'] is EXTENSION


def listed_in_full_registration():
    return Registration(
        reg_number="123ABC",
        reg_number_status="listed_in_full",
        vin="WVWZZZ1KZAW000001",
        vin_status="listed_in_full",
        vin_format="standard",
    )


def listing_opener(content=None):
    """A fake opener yielding the fixture page; it accepts a deadline and an observer."""
    page = FakePage() if content is None else SimpleNamespace(content=lambda: content)

    @contextmanager
    def opener(url, *, profile_dir=None, deadline=None, observer=None):
        yield SimpleNamespace(page=page, main_frame_blocked=False, blocked=[])

    return opener


def capture_with_reveal(reveal, opener=None):
    """Run the real capture_listing with a fake opener and a fake reveal."""

    def capture(url, **kwargs):
        return worker.capture_listing(url, solver=object(), opener=opener or listing_opener(), reveal=reveal, **kwargs)

    return capture


def recording_reveal(client, registration):
    def reveal(*_args, **_kwargs):
        client.calls.append("reveal")
        return SimpleNamespace(registration=registration, diagnostics=RevealDiagnostics())

    return reveal


def test_job_completes_before_the_reveal_runs():
    client = FakeStorageClient(claimed_job())

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    assert worker.run_once(client, capture, parse_listing) is True

    assert client.calls[:2] == ["complete", "reveal"]
    registration = client.completed[0][2]["registration"]
    assert (registration["reg_number_status"], registration["vin_status"]) == ("pending", "pending")
    assert registration["reg_number"] is None and registration["vin"] is None
    assert isinstance(client.reveal_tokens[0], str) and client.reveal_tokens[0]


def test_reveal_result_is_posted_with_the_token():
    client = FakeStorageClient(claimed_job())

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    assert worker.run_once(client, capture, parse_listing) is True

    assert client.calls == ["complete", "reveal", "set_registration"]
    assert client.registrations == [("job-1", client.reveal_tokens[0], revealed_registration())]
    assert client.diagnostics.engine == "camoufox"
    assert client.failed == []


def test_parse_failure_fails_the_job_and_skips_the_reveal():
    client = FakeStorageClient(claimed_job())

    capture = capture_with_reveal(
        recording_reveal(client, revealed_registration()), listing_opener("<main>not a listing</main>")
    )
    assert worker.run_once(client, capture, parse_listing) is True

    assert client.failed[0][0:3] == ("job-1", LEASE_TOKEN, "parse_failed")
    assert "reveal" not in client.calls
    assert client.completed == [] and client.registrations == []


def test_parse_failure_is_not_re_recorded_when_the_failure_report_raises():
    class Client(FakeStorageClient):
        def fail(self, *args):
            super().fail(*args)
            if len(self.failed) == 1:
                raise RuntimeError("storage unavailable")
            return True

    client = Client(claimed_job())

    def broken_parser(_html, _url):
        raise ValueError("no listing")

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    assert worker.run_once(client, capture, broken_parser) is True

    assert [call[2] for call in client.failed] == ["parse_failed"]
    assert "reveal" not in client.calls and client.registrations == []


def test_completion_error_fails_retryably_and_skips_the_reveal():
    class Client(FakeStorageClient):
        def complete(self, *args, **kwargs):
            raise RuntimeError("storage unavailable")

    client = Client(claimed_job())

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    assert worker.run_once(client, capture, parse_listing) is True

    assert [call[2] for call in client.failed] == ["temporary_failure"]
    assert client.failed[0][4] is True
    assert "reveal" not in client.calls and client.registrations == []


def test_rejected_identity_update_is_logged_distinctly(caplog):
    class Client(FakeStorageClient):
        def set_registration(self, *args):
            super().set_registration(*args)
            return False

    client = Client(claimed_job())
    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True

    assert "registration=rejected" in caplog.text
    assert "123ABC" not in caplog.text


def test_superseded_completion_skips_the_reveal(caplog):
    client = FakeStorageClient(claimed_job())
    client.complete_result = False

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True

    assert client.calls == ["complete"]
    assert client.registrations == [] and client.failed == []
    assert "status=superseded reg_number_status=none vin_status=none" in caplog.text


def test_listed_in_full_fills_in_right_after_completion():
    times = {}

    class TimedClient(FakeStorageClient):
        def complete(self, *args, **kwargs):
            times["complete"] = worker.time.monotonic()
            return super().complete(*args, **kwargs)

        def set_registration(self, *args, **kwargs):
            times["set_registration"] = worker.time.monotonic()
            return super().set_registration(*args, **kwargs)

    client = TimedClient(claimed_job())
    capture = capture_with_reveal(recording_reveal(client, listed_in_full_registration()))
    assert worker.run_once(client, capture, parse_listing) is True

    assert client.registrations[0][2].reg_number_status == "listed_in_full"
    assert 0 <= times["set_registration"] - times["complete"] < 1.0


def test_reveal_logs_statuses_only(caplog):
    client = FakeStorageClient(claimed_job())

    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    with caplog.at_level(logging.DEBUG):
        assert worker.run_once(client, capture, parse_listing) is True

    assert "status=completed" in caplog.text
    assert "reg_number_status=revealed" in caplog.text
    assert "vin_status=revealed" in caplog.text
    assert "123ABC" not in caplog.text
    assert "WVWZZZ1KZAW000001" not in caplog.text


def test_timing_stops_at_completion():
    import threading

    first_write = threading.Event()

    class Client(FakeStorageClient):
        def __init__(self):
            super().__init__(claimed_job())
            self.events, self.spans = [], []

        def record_spans(self, job_id, lease_token, spans, *, timeout, omitted=0):
            self.events.append("spans")
            if any(span.phase == "navigation" for span in spans):
                first_write.set()
                raise RuntimeError("storage unavailable")
            self.spans.extend(spans)
            return True

        def complete(self, *args, diagnostic_omitted=0, **kwargs):
            self.events.append("complete")
            self.final_omitted = diagnostic_omitted
            return super().complete(*args, **kwargs)

    @contextmanager
    def opener(url, *, profile_dir=None, deadline=None, observer=None):
        with observer.phase("navigation"):
            pass
        first_write.wait(1)  # the failed write is counted before parsing starts
        try:
            yield SimpleNamespace(page=FakePage(), main_frame_blocked=False, blocked=[])
        finally:
            with observer.phase("browser_shutdown"):
                pass

    def reveal(*_args, **_kwargs):
        client.events.append("reveal")
        return SimpleNamespace(registration=revealed_registration(), diagnostics=RevealDiagnostics())

    client = Client()
    capture = capture_with_reveal(reveal, opener)
    assert worker.run_once(client, capture, parse_listing, diagnostics_enabled=True) is True

    completed_at = client.events.index("complete")
    assert "spans" not in client.events[completed_at:]
    assert "reveal" in client.events[completed_at:]
    assert any(span.phase == "parsing" and span.state == "complete" for span in client.spans)
    assert not any(span.phase == "browser_shutdown" for span in client.spans)
    assert client.final_omitted > 0


def test_capture_error_after_completion_never_fails_the_job(caplog):
    client = FakeStorageClient(claimed_job())

    def capture(_url, *, on_html, **_kw):
        on_html(FIXTURE.read_text(encoding="utf-8"))
        raise CaptureError("temporary_failure")

    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True

    assert client.failed == [] and client.registrations == []
    assert len(client.completed) == 1
    assert "reg_number_status=pending" in caplog.text


def test_registration_post_failure_does_not_stop_the_worker(caplog):
    class Client(FakeStorageClient):
        def set_registration(self, *args, **kwargs):
            self.calls.append("set_registration")
            raise RuntimeError("storage unavailable 123ABC")

    client = Client(claimed_job())
    capture = capture_with_reveal(recording_reveal(client, revealed_registration()))
    with caplog.at_level(logging.INFO, logger=worker.__name__):
        assert worker.run_once(client, capture, parse_listing) is True

    assert client.calls[-1] == "set_registration"
    assert client.failed == []
    assert "reg_number_status=revealed" in caplog.text
    assert "123ABC" not in caplog.text


def test_warm_capture_passes_one_profile_across_jobs(tmp_path):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')
    seen = []
    result = captured('html')
    callback, observer = object(), object()

    def capture(*args, **kwargs):
        seen.append((args, kwargs))
        return result

    wrapped = worker.warm_capture(capture, warm)
    for _ in range(2):
        assert wrapped(LISTING_URL, deadline=12, on_html=callback, observer=observer) is result
    assert seen[0] == seen[1]
    assert seen[0] == ((LISTING_URL,), dict(deadline=12, on_html=callback, observer=observer,
                                         keep_profile=tmp_path / 'warm' / 'profile-0'))
    assert warm.jobs == 2


def test_blocked_job_resets_before_the_next_one(tmp_path):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')
    paths = []
    error = CaptureError('access_blocked')

    def capture(_url, *, keep_profile):
        paths.append(keep_profile)
        if len(paths) == 1:
            (keep_profile / 'cookie').write_text('123ABC')
            raise error
        assert not paths[0].exists()
        assert list(keep_profile.iterdir()) == []
        return captured('html')

    wrapped = worker.warm_capture(capture, warm)
    with pytest.raises(CaptureError) as exc:
        wrapped(LISTING_URL)
    assert exc.value is error
    assert warm.jobs == 0
    wrapped(LISTING_URL)
    assert paths[0] != paths[1]
    assert warm.jobs == 1


def test_try_again_later_resets_the_profile(tmp_path):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')
    diagnostics = RevealDiagnostics(attempts=[AttemptRecord(
        attempt=1, started_at=LEASE_UNTIL, duration_ms=10,
        outcome='failed', reason='try_again_later',
    )])
    result = CaptureResult(html='html', registration=None, reveal_diagnostics=diagnostics)
    assert worker.warm_capture(lambda *a, **kw: result, warm)(LISTING_URL) is result
    assert warm.jobs == 0
    assert not (tmp_path / 'warm' / 'profile-0').exists()


@pytest.mark.parametrize('error', [CaptureError('temporary_failure'), RuntimeError('123ABC')])
def test_warm_capture_records_other_errors_once(tmp_path, error):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')

    def capture(*args, **kwargs):
        raise error

    with pytest.raises(type(error)) as exc:
        worker.warm_capture(capture, warm)(LISTING_URL)
    assert exc.value is error
    assert warm.jobs == 1
    assert (tmp_path / 'warm' / 'profile-0').exists()


def test_profile_logs_counts_and_reasons_only(tmp_path, caplog):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm', max_jobs=3)
    calls = 0

    def capture(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 4:
            raise CaptureError('access_blocked')
        return CaptureResult(html='123ABC', registration=revealed_registration(), reveal_diagnostics=None)

    wrapped = worker.warm_capture(capture, warm)
    with caplog.at_level(logging.INFO, logger=worker.__name__):
        for _ in range(3):
            wrapped(LISTING_URL)
        with pytest.raises(CaptureError):
            wrapped(LISTING_URL)
    assert [r.getMessage() for r in caplog.records] == [
        'profile_jobs=1', 'profile_jobs=2', 'profile_jobs=3',
        'profile_reset reason=count', 'profile_jobs=1', 'profile_reset reason=blocked',
    ]
    assert '123ABC' not in caplog.text
    assert LISTING_URL not in caplog.text


@pytest.mark.parametrize('setting', [None, ' TrUe ', 'false', ' FaLsE ', 'maybe'])
def test_warm_profile_can_be_switched_off(monkeypatch, tmp_path, capsys, setting):
    import auto24_service.browser_chromium as chromium
    monkeypatch.setenv('CAPTURE_ENGINE', 'chromium')
    monkeypatch.setenv('STORAGE_URL', 'http://127.0.0.1:8001')
    monkeypatch.setenv('INTERNAL_API_KEY', 'test-key')
    if setting is None:
        monkeypatch.delenv('CHROMIUM_WARM_PROFILE', raising=False)
    else:
        monkeypatch.setenv('CHROMIUM_WARM_PROFILE', setting)
    monkeypatch.setattr(worker.tempfile, 'gettempdir', lambda: str(tmp_path))
    monkeypatch.setattr(chromium, 'sweep_leftovers', lambda root: None)
    monkeypatch.setattr(worker, 'StorageClient', lambda *a: FakeMainClient())
    seen = []
    monkeypatch.setattr(worker, 'capture_listing', lambda *a, **kw: seen.append(kw) or captured('html'))
    monkeypatch.setattr(worker, 'run_once', lambda client, capture, parser: capture(LISTING_URL))
    if setting == 'maybe':
        with pytest.raises(SystemExit) as exc:
            worker.main(['--once'])
        assert exc.value.code == 2
        assert 'CHROMIUM_WARM_PROFILE' in capsys.readouterr().err
        assert not (tmp_path / 'a24-warm').exists()
        return
    assert worker.main(['--once']) == 0
    enabled = setting is None or setting.strip().lower() == 'true'
    assert ('keep_profile' in seen[0]) is enabled
    assert (tmp_path / 'a24-warm').exists() is enabled
    if enabled:
        assert seen[0]['keep_profile'] == tmp_path / 'a24-warm' / 'profile-0'


class FakeMainClient:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


@pytest.mark.parametrize('code,expected', [('browser_launch', 'launch'), ('extension_not_loaded', 'launch'), ('temporary_failure', 'temporary')])
def test_warm_capture_new_error_resets(tmp_path, caplog, code, expected):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')
    def capture(*args, **kwargs):
        raise CaptureError(code)
    wrapped = worker.warm_capture(capture, warm)
    with caplog.at_level('INFO'):
        for _ in range(2 if code == 'temporary_failure' else 1):
            with pytest.raises(CaptureError):
                wrapped(LISTING_URL)
    assert warm.jobs == 0
    assert f'profile_reset reason={expected}' in caplog.text


@pytest.mark.parametrize('reason', ['timeout', 'captcha_rounds_exhausted'])
def test_warm_capture_failed_reveal_resets(tmp_path, reason):
    from auto24_service.warm_profile import WarmProfile
    warm = WarmProfile(tmp_path / 'warm')
    result = CaptureResult('html', Registration(reg_number_status='unavailable'),
        RevealDiagnostics(attempts=[AttemptRecord(attempt=1, started_at=LEASE_UNTIL,
            duration_ms=1, outcome='failed', reason=reason)]))
    worker.warm_capture(lambda *a, **kw: result, warm)(LISTING_URL)
    assert warm.jobs == 0
