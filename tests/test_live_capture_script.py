import importlib.util
from pathlib import Path

from auto24_service.contracts import AttemptRecord, RoundRecord, TileRecord

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sandbox-live-capture.py"


def _load():
    spec = importlib.util.spec_from_file_location("sandbox_live_capture", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_format_attempts_prints_round_details_and_no_values():
    tiles = [TileRecord(method="lookup", selected=True)] * 2 + [TileRecord(method="model", score=0.5, selected=False)] * 7
    record = AttemptRecord(
        attempt=1,
        started_at="2026-10-12T10:00:00Z",
        duration_ms=90000,
        outcome="failed",
        reason="timeout",
        error_type="TimeoutError",
        stage="captcha_round",
        prefix_check={"reg_number": "failed"},
        blocked_requests=["www.example.com/x/"],
        rounds=[
            RoundRecord(
                grid="3x3", instruction="Select all images with\ncars", label_id="/m/0k4j", label="cars",
                label_source="id", tiles=tiles, tiles_clicked=[0, 1], duration_ms=40000,
                result="timeout", stage="verify_wait",
            )
        ],
    )
    text = "\n".join(_load().format_attempts([record]))
    for part in (
        "reveal attempts: 1", "error_type=TimeoutError", "stage=captcha_round", "duration_ms=90000",
        "grid=3x3", "label_source=id", "label=cars", "label_id=/m/0k4j", "result=timeout",
        "stage=verify_wait", "duration_ms=40000", "lookup=2 model=7 none=0", "tiles_clicked=2",
        "instruction='Select all images with\\ncars'",
    ):
        assert part in text, part
    assert "www.example.com" not in text and "score" not in text


def _patched(monkeypatch, capture):
    module = _load()
    monkeypatch.setattr(module, "verify_solver_dir", lambda path: None)
    monkeypatch.setattr(module, "load_solver", lambda path: "solver")
    monkeypatch.setattr(module, "capture_listing", capture)
    return module


def test_deadline_seconds_becomes_a_monotonic_deadline(monkeypatch, capsys):
    import sys
    import time

    from auto24_service.contracts import Registration

    seen = {}

    class Result:
        registration = Registration(reg_number_status="unavailable", vin_status="unavailable")
        reveal_diagnostics = None

    def capture(url, *, solver, deadline=None, debug=None):
        seen.update(url=url, solver=solver, deadline=deadline, debug=debug)
        return Result()

    module = _patched(monkeypatch, capture)
    monkeypatch.setattr(sys, "argv", ["x", "--url", "https://www.auto24.ee/soidukid/1", "--deadline-seconds", "90"])
    before = time.monotonic()
    assert module.main() == 0
    assert before + 90 <= seen["deadline"] <= time.monotonic() + 90
    assert seen["solver"] == "solver" and seen["debug"] is None
    out = capsys.readouterr().out
    assert "deadline_seconds: 90.0" in out and "reg_number_status: unavailable" in out

    monkeypatch.setattr(sys, "argv", ["x", "--url", "https://www.auto24.ee/soidukid/1"])
    assert module.main() == 0
    assert seen["deadline"] is None


def test_capture_error_prints_only_its_code(monkeypatch, capsys):
    import sys

    from auto24_service.browser import CaptureError

    def capture(url, **_kw):
        raise CaptureError("access_blocked")

    module = _patched(monkeypatch, capture)
    monkeypatch.setattr(sys, "argv", ["x", "--url", "https://www.auto24.ee/soidukid/1"])
    assert module.main() == 1
    out = capsys.readouterr().out
    assert "capture failed: access_blocked" in out
    assert "auto24.ee" not in out
