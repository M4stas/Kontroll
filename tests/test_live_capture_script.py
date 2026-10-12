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
