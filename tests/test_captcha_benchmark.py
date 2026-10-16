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
                capture=capture, solver_loader=lambda d, use_lookup=False: object())
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


def test_capture_error_is_counted_and_report_still_written(tmp_path):
    class CaptureError(Exception):
        code = "blocked"

    results = [ok()] * 4 + [CaptureError()] + [ok()] * 6
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\n")
    queue = list(results)

    def capture(url, *, solver, profile_dir=None, save_image=None, **kw):
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    out = tmp_path / "out"
    code = main(["--mode", "fresh", "--listings", str(listings), "--label", "t", "--out", str(out)],
                capture=capture, solver_loader=lambda d, use_lookup=False: object())
    r = json.loads((next(out.iterdir()) / "report.json").read_text())["modes"]["fresh"]
    assert code == 0 and r["attempted"] == 10 and r["capture_errors"] == {"blocked": 1}


def test_help_exits_zero():
    assert main(["--help"]) == 0


def test_prints_a_summary_and_the_report_folder(tmp_path, capsys):
    code, d, _ = run(tmp_path, [ok()] * 8 + [retry_ok(), bad()])
    out = capsys.readouterr().out
    assert code == 0
    assert "fresh: gate=PASS attempted=10 success_attempt_1=8 success_with_retry=1 lookup_hit_rate=0.5" in out
    assert "reasons: {'timeout': 3}" in out
    assert f"report: {d}" in out
    assert REG not in out and VIN not in out


def test_missing_or_empty_listings_file_prints_an_error_and_exits_2(tmp_path, capsys):
    missing = tmp_path / "nope.txt"
    assert main(["--listings", str(missing), "--label", "t", "--out", str(tmp_path / "o")]) == 2
    err = capsys.readouterr().err
    assert "cannot read listings file" in err and str(missing) in err
    empty = tmp_path / "empty.txt"
    empty.write_text("# only a comment\n\n")
    assert main(["--listings", str(empty), "--label", "t", "--out", str(tmp_path / "o")]) == 2
    assert "has no URLs" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def test_argument_errors_print_to_stderr_and_exit_2(tmp_path, capsys):
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\n")
    assert main(["--listings", str(listings)]) == 2
    assert "--label" in capsys.readouterr().err
    assert main(["--listings", str(listings), "--label", "bad label"]) == 2
    assert "--label must match" in capsys.readouterr().err
    assert main(["--listings", str(listings), "--label", "t", "--reveals", "0"]) == 2
    assert "--reveals must be at least 1" in capsys.readouterr().err


def test_report_lists_each_reveal_without_values(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 8 + [retry_ok(), bad()])
    reveals = json.loads((d / "report.json").read_text())["reveals"]
    assert len(reveals) == 10
    assert [r["n"] for r in reveals] == list(range(1, 11))
    assert reveals[0]["url"] == "https://www.auto24.ee/a" and reveals[0]["mode"] == "fresh"
    assert [r["result"] for r in reveals[-2:]] == ["success_with_retry", "failed"]
    a = reveals[-1]["attempts"][0]
    assert set(a) == {
        "attempt", "outcome", "reason", "stage", "error_type", "pass_evidence", "duration_ms", "rounds_count", "rounds",
    }
    assert (a["outcome"], a["reason"], a["rounds_count"]) == ("failed", "timeout", 1)
    assert a["rounds"][0] == {
        "grid": "3x3", "label": "car", "label_id": "c", "label_source": "id", "result": "solved",
        "stage": None, "tile_methods": {"lookup": 1, "model": 1, "none": 1},
    }
    md = (d / "report.md").read_text()
    assert "## Failed attempts" in md
    assert "fresh #10 attempt 2 (failed): reason=timeout" in md
    assert "fresh #9 attempt 1 (success_with_retry): reason=timeout" in md
    for name in ("report.json", "report.md"):
        text = (d / name).read_text().casefold()
        assert REG.casefold() not in text and VIN.casefold() not in text
        assert "token" not in text and "cookie" not in text


def test_report_records_lookup_setting(tmp_path, monkeypatch):
    seen = []
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\n")
    for value, expected in ((None, False), ("true", True)):
        if value is None:
            monkeypatch.delenv("CAPTCHA_LOOKUP_ENABLED", raising=False)
        else:
            monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", value)
        out = tmp_path / f"out-{expected}"
        main(["--mode", "fresh", "--reveals", "1", "--listings", str(listings), "--label", "t", "--out", str(out)],
             capture=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("stop")),
             solver_loader=lambda d, use_lookup=False: seen.append(use_lookup) or object())
    assert seen == [False, True]
    flags = [json.loads(next(d.iterdir()).joinpath('report.json').read_text())['lookup_enabled']
             for d in (tmp_path / 'out-False', tmp_path / 'out-True')]
    assert flags == [False, True]


def test_non_utf8_listings_file_prints_an_error_and_exits_2(tmp_path, capsys):
    listings = tmp_path / "l.txt"
    listings.write_bytes(b"https://www.auto24.ee/\xff\xfe\n")
    assert main(["--listings", str(listings), "--label", "t", "--out", str(tmp_path / "o")]) == 2
    assert "is not UTF-8 text" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def _listings(tmp_path):
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/soidukid/900001\n")
    return listings


def test_debug_is_off_by_default_and_passes_nothing(tmp_path):
    seen = []

    def capture(url, **kw):
        seen.append(set(kw))
        return ok()

    out = tmp_path / "out"
    main(["--mode", "fresh", "--listings", str(_listings(tmp_path)), "--label", "t", "--out", str(out),
          "--reveals", "2"], capture=capture, solver_loader=lambda d, use_lookup=False: object())
    run_dir = next(out.iterdir())
    assert seen == [{"solver", "profile_dir", "save_image"}] * 2
    assert not (run_dir / "debug").exists()
    assert json.loads((run_dir / "report.json").read_text())["debug"] is False


def test_debug_writes_a_folder_per_reveal_with_the_fake_site(tmp_path):
    import pytest

    pytest.importorskip("camoufox.sync_api")
    from fakesite import LISTING_URL, Scenario, install_fake_site

    from auto24_service.browser import capture_listing, open_listing
    from auto24_service.captcha.solver import Decision

    class Stub:
        def solve_grid(self, label, kind, image):
            n = 16 if kind == "4x4" else 9
            return Decision([TileRecord(method="model", score=0.5, selected=i in (0, 4, 8)) for i in range(n)])

        def solve_tiles(self, label, tiles):
            return Decision([TileRecord(method="model", score=0.1, selected=False) for _ in tiles])

    def opener(url, profile_dir=None):
        return open_listing(LISTING_URL, profile_dir=profile_dir,
                            setup=lambda c: install_fake_site(c, Scenario(grid="3x3")))

    def capture(url, **kw):
        return capture_listing(url, opener=opener, **kw)

    out = tmp_path / "out"
    main(["--mode", "fresh", "--listings", str(_listings(tmp_path)), "--label", "t", "--out", str(out),
          "--reveals", "1", "--debug"], capture=capture, solver_loader=lambda d, use_lookup=False: Stub())
    run_dir = next(out.iterdir())
    report_json = json.loads((run_dir / "report.json").read_text())
    assert report_json["debug"] is True and report_json["reveals"][0]["result"] == "success_attempt_1"
    folder = run_dir / "debug" / "fresh-1"
    lines = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()]
    events = [r["event"] for r in lines]
    assert events[0] == "trigger_clicked" and "challenge_data" in events and "verify_result" in events
    for r in lines:
        if r["screenshot"]:
            assert (folder / r["screenshot"]).read_bytes()[:4] == b"\x89PNG"
    text = (folder / "events.jsonl").read_text()
    assert "?" not in text and "#" not in text and "123ABC" not in text and "WVWZZZ" not in text
