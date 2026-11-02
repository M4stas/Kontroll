"""Daily checks must measure reveals rather than successful HTML captures."""

import importlib.util
import io
import json
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "daily_reveal_check", Path(__file__).parents[1] / "scripts/daily-reveal-check.py"
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def job(reg="revealed", vin="not_listed", status="completed"):
    return {"status": status, "listing": {"registration": {
        "reg_number_status": reg, "vin_status": vin,
    }}}


def test_waits_for_reveal_after_listing_completes():
    assert check.outcome(job("pending")) is None
    assert check.outcome(job(status="running")) is None


def test_missing_reveal_is_a_failure():
    assert check.outcome(job("unavailable")) == "reveal_failed"
    assert check.outcome(job("revealed", "unavailable")) == "reveal_failed"


def test_listed_values_do_not_prove_solver_health():
    assert check.outcome(job("listed_in_full")) == "no_reveal"
    assert check.outcome(job("not_listed")) == "no_reveal"
    assert check.outcome({"status": "completed", "listing": {}}) == "no_reveal"


def test_reveal_and_capture_failure():
    assert check.outcome(job()) == "revealed"
    assert check.outcome(job(status="failed")) == "capture_failed"


def test_threshold_includes_all_samples():
    assert check.passed(["revealed"] * 4 + ["timeout"], 0.8)
    assert not check.passed(["revealed", "no_reveal", "timeout"], 0.8)
    assert not check.passed([], 0.8)


def test_submits_fresh_job_and_polls_pending_registration(monkeypatch):
    identifier = "550e8400-e29b-41d4-a716-446655440000"
    responses = iter([
        {"job_id": identifier, "status": "queued"}, job("pending"), job(),
    ])
    requests = []

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            return io.StringIO(json.dumps(next(responses)))

    monkeypatch.setattr(check, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(check.time, "sleep", lambda seconds: None)
    assert check.sample("https://service.invalid", "key", "listing", 30) == "revealed"
    assert requests[0].get_method() == "POST"
    assert json.loads(requests[0].data) == {"url": "listing"}
    assert [request.full_url for request in requests[1:]] == [
        f"https://service.invalid/v1/jobs/{identifier}",
    ] * 2


def test_deadline_stops_network_requests(monkeypatch):
    ticks = iter([0, 31])
    monkeypatch.setattr(check.time, "monotonic", lambda: next(ticks))
    try:
        check.sample("https://service.invalid", "key", "listing", 30)
    except TimeoutError:
        pass
    else:
        raise AssertionError("expired deadline must stop the request")


def test_redirects_are_rejected():
    assert check.NoRedirect().redirect_request(
        None, None, 302, "redirect", {}, "https://other.invalid",
    ) is None


def test_errors_do_not_expose_credentials_or_responses(monkeypatch, capsys):
    monkeypatch.setenv("REVEAL_CHECK_API_URL", "https://service.invalid")
    monkeypatch.setenv("REVEAL_CHECK_API_KEY", "private-key")
    monkeypatch.setenv("REVEAL_CHECK_LISTINGS", "\n".join(
        f"https://www.auto24.ee/soidukid/{index}" for index in range(3)
    ))
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.delenv("REVEAL_CHECK_MIN_RATE", raising=False)
    monkeypatch.delenv("REVEAL_CHECK_TIMEOUT_SECONDS", raising=False)

    def fail(*args):
        raise RuntimeError("private-key response-with-vehicle-data")

    monkeypatch.setattr(check, "sample", fail)
    assert check.main() == 1
    output = capsys.readouterr().out
    assert '"service_error": 3' in output
    assert "private-key" not in output
    assert "vehicle-data" not in output
    assert "auto24.ee" not in output
