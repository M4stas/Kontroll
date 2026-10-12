import json
import re
from datetime import datetime, timezone
from pathlib import Path

from auto24_service.captcha_benchmark import main
from auto24_service.contracts import (
    AttemptRecord,
    Registration,
    RevealDiagnostics,
    RoundRecord,
    TileRecord,
)

REG = "123ABC"
VIN = "WVWZZZ1KZAW000000"


def _round(result="solved", source="id"):
    return RoundRecord(
        grid="3x3", instruction="cars", label_id="c", label="car", label_source=source,
        tiles=[TileRecord(method="lookup", selected=True), TileRecord(method="model", selected=False),
               TileRecord(method="none", selected=False)],
        tiles_clicked=[0], duration_ms=100, result=result,
    )


def _attempt(n, outcome, reason=None, rounds=1, checkbox_only=False):
    return AttemptRecord(
        attempt=n, started_at=datetime.now(timezone.utc), duration_ms=1000, outcome=outcome,
        reason=reason, checkbox_only=checkbox_only, rounds=[_round() for _ in range(rounds)],
    )


class Result:
    def __init__(self, registration, attempts):
        self.html = "<html/>"
        self.registration = registration
        self.reveal_diagnostics = RevealDiagnostics(attempts=attempts)


def revealed():
    return Registration(reg_number=REG, reg_number_status="revealed", vin=VIN,
                        vin_status="revealed", vin_format="standard")


def failed():
    return Registration(reg_number_status="unavailable", vin_status="unavailable")


def ok():
    return Result(revealed(), [_attempt(1, "revealed")])


def bad():
    return Result(failed(), [_attempt(1, "failed", "timeout"), _attempt(2, "failed", "timeout")])


def retry_ok():
    return Result(revealed(), [_attempt(1, "failed", "timeout"), _attempt(2, "revealed")])


def skipped():
    return Result(Registration(reg_number="1", reg_number_status="listed_in_full",
                               vin_status="not_listed"), [])


def run(tmp_path, results, *extra, mode="fresh"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("# c\nhttps://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    calls = []
    queue = list(results)

    def capture(url, *, solver, profile_dir=None, save_image=None, **kw):
        calls.append((url, profile_dir))
        if save_image:
            save_image("x.jpg", b"jpg")
        return queue.pop(0)

    out = tmp_path / "out"
    code = main(["--mode", mode, "--listings", str(listings), "--label", "t", "--out", str(out), *extra],
                capture=capture, solver_loader=lambda d: object())
    run_dir = next(out.iterdir())
    return code, run_dir, calls


def report(run_dir, mode="fresh"):
    return json.loads((run_dir / "report.json").read_text())["modes"][mode]


def test_gate_passes_at_8_of_10_and_fails_at_7_of_10(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 8 + [retry_ok(), bad()])
    assert code == 0 and report(d)["gate"] == "PASS"
    assert report(d)["success_with_retry"] == 1
    code, d, _ = run(tmp_path / "b", [ok()] * 7 + [retry_ok(), bad(), bad()])
    assert code == 1 and report(d)["gate"] == "FAIL"


def test_fewer_than_10_reveals_reports_insufficient(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 3, "--reveals", "3")
    assert code == 1 and report(d)["gate"] == "INSUFFICIENT"


def test_listings_without_reveal_links_are_skipped_not_counted(tmp_path):
    code, d, _ = run(tmp_path, [skipped(), skipped()] + [ok()] * 10)
    r = report(d)
    assert r["skipped"] == 2 and r["attempted"] == 10 and code == 0


def test_report_contains_rates_reasons_and_versions_but_no_values_or_ip(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 8 + [bad(), bad()])
    r = report(d)
    assert r["reason_counts"]["timeout"] >= 1
    assert r["lookup_hit_rate"] == 0.5
    assert r["label_source_counts"]["id"] > 0
    top = json.loads((d / "report.json").read_text())
    assert top["label"] == "t" and "package_version" in top and "camoufox_version" in top
    assert "solver_hashes" in top and top["listings"] == ["https://www.auto24.ee/a", "https://www.auto24.ee/b"]
    for name in ("report.json", "report.md"):
        text = (d / name).read_text()
        assert REG not in text and VIN not in text
        assert not re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", text)


def test_images_are_written_under_the_run_folder(tmp_path):
    _, d, _ = run(tmp_path, [ok()] * 10)
    assert list((d / "images").glob("*.jpg"))


def test_saved_mode_deletes_profile_unless_keep_profile(tmp_path):
    _, d, calls = run(tmp_path, [ok()] * 10, mode="saved")
    profiles = {c[1] for c in calls}
    assert len(profiles) == 1 and None not in profiles
    assert not Path(next(iter(profiles))).exists()
    _, d, calls = run(tmp_path / "k", [ok()] * 10, "--keep-profile", mode="saved")
    p = Path(calls[0][1])
    assert p.exists()
