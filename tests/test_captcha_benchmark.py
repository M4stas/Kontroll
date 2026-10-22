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


class CaptureError(Exception):
    code = "blocked"


def _fake_capture(queue, calls):
    def capture(url, *, solver, profile_dir=None, save_image=None, **kw):
        calls.append((url, profile_dir))
        if save_image:
            save_image("x.jpg", b"jpg")
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return capture


def run(tmp_path, results, *extra, mode="fresh", **kwargs):
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("# c\nhttps://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    calls = []
    out = tmp_path / "out"
    code = main(["--mode", *mode.split(), "--listings", str(listings), "--label", "t", "--out", str(out), *extra],
                capture=_fake_capture(list(results), calls),
                solver_loader=lambda d, use_lookup=False: object(), **kwargs)
    run_dir = next(out.iterdir())
    return code, run_dir, calls


def report(run_dir, mode="camoufox/fresh"):
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


def test_report_contains_rates_reasons_and_versions_but_no_values_or_ip(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", "true")
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


def test_capture_errors_count_as_failed_reveals(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 8 + [CaptureError(), CaptureError()])
    r = report(d)
    assert code == 0 and r["gate"] == "PASS"
    assert r["attempted"] == 10 and r["success_rate"] == 0.8
    assert r["capture_errors"] == {"blocked": 2} and r["capture_errors_counted"] is True
    top = json.loads((d / "report.json").read_text())
    assert len(top["reveals"]) == 10
    assert top["reveals"][8]["result"] == "capture_error" and top["reveals"][8]["capture_error"] == "blocked"
    code, d, _ = run(tmp_path / "b", [ok()] * 7 + [CaptureError()] * 3)
    assert code == 1 and report(d)["gate"] == "FAIL" and report(d)["attempted"] == 10


def test_help_exits_zero():
    assert main(["--help"]) == 0


def test_prints_a_summary_and_the_report_folder(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", "true")
    code, d, _ = run(tmp_path, [ok()] * 8 + [retry_ok(), bad()])
    out = capsys.readouterr().out
    assert code == 0
    assert "camoufox/fresh: gate=PASS attempted=10 success_attempt_1=8 success_with_retry=1 no_captcha_needed=0 lookup_hit_rate=0.5" in out
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
    assert reveals[0]["url"] == "https://www.auto24.ee/a" and reveals[0]["mode"] == "fresh" and reveals[0]["engine"] == "camoufox"
    assert [r["result"] for r in reveals[-2:]] == ["success_with_retry", "failed"]
    a = reveals[-1]["attempts"][0]
    assert set(a) == {
        "attempt", "started", "outcome", "reason", "stage", "error_type", "pass_evidence", "duration_ms", "rounds_count", "rounds",
    }
    assert (a["outcome"], a["reason"], a["rounds_count"]) == ("failed", "timeout", 1)
    assert a["rounds"][0] == {
        "grid": "3x3", "label": "car", "label_id": "c", "label_source": "id", "result": "solved",
        "stage": None, "tile_methods": {"lookup": 1, "model": 1, "none": 1},
    }
    md = (d / "report.md").read_text()
    assert "## Failed attempts" in md
    assert "camoufox/fresh #10 attempt 2 (failed): reason=timeout" in md
    assert "camoufox/fresh #9 attempt 1 (success_with_retry): reason=timeout" in md
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
    assert seen == [{"solver", "profile_dir", "save_image", "deadline"}] * 2
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
    folder = run_dir / "debug" / "camoufox-fresh-1"
    lines = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()]
    events = [r["event"] for r in lines]
    assert events[0] == "trigger_clicked" and "challenge_data" in events and "verify_result" in events
    for r in lines:
        if r["screenshot"]:
            assert (folder / r["screenshot"]).read_bytes()[:4] == b"\x89PNG"
    text = (folder / "events.jsonl").read_text()
    assert "?" not in text and "#" not in text and "123ABC" not in text and "WVWZZZ" not in text


def test_prints_progress_per_listing_without_values(tmp_path, capsys):
    run(tmp_path, [ok(), skipped(), retry_ok()] + [ok()] * 8)
    err = capsys.readouterr().err
    assert "[camoufox/fresh 1/10] listing 1: opening" in err
    assert "[camoufox/fresh 2/10] listing 2: skipped, nothing to reveal" in err
    assert "[camoufox/fresh 2/10] listing 1: success_with_retry (attempt 1 timeout in" in err
    assert "attempt 2 revealed in" in err and ", 1 of 2 on attempt 1" in err
    assert "[camoufox/fresh 10/10]" in err and "[camoufox/fresh 11/10]" not in err
    assert REG not in err and VIN not in err and "auto24.ee" not in err


def test_lookup_hit_rate_is_none_with_the_lookup_off(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CAPTCHA_LOOKUP_ENABLED", raising=False)
    code, d, _ = run(tmp_path, [ok()] * 10)
    assert report(d)["lookup_hit_rate"] is None
    assert "lookup_hit_rate=None" in capsys.readouterr().out


def test_each_capture_gets_the_worker_lease_deadline(tmp_path):
    import time

    from auto24_service.store import LEASE_DURATION
    from auto24_service.worker import LEASE_SAFETY_SECONDS

    seen = []
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\n")

    def capture(url, *, solver, deadline=None, **kw):
        seen.append(deadline - time.monotonic() if deadline is not None else None)
        return ok()

    main(["--mode", "fresh", "--reveals", "2", "--listings", str(listings), "--label", "t", "--out", str(tmp_path / "o")],
         capture=capture, solver_loader=lambda d, use_lookup=False: object())
    budget = LEASE_DURATION.total_seconds() - LEASE_SAFETY_SECONDS
    assert len(seen) == 2
    assert all(s is not None and budget - 5 < s <= budget for s in seen)


def test_report_distinguishes_partial_fields_and_skipped_retry(tmp_path):
    partial = Registration(reg_number=REG, reg_number_status="revealed", vin_status="unavailable")
    skipped_retry = _attempt(2, "failed", "timeout", rounds=0).model_copy(update={"duration_ms": 0})
    _, folder, _ = run(tmp_path, [Result(partial, [_attempt(1, "failed", "timeout"), skipped_retry])],
                       "--reveals", "1")
    top = json.loads((folder / "report.json").read_text())
    record = top["reveals"][0]
    assert record["field_statuses"] == {"reg_number": "revealed", "vin": "unavailable"}
    assert record["attempts"][1]["started"] is False
    assert record["capture_duration_ms"] >= 0
    assert top["modes"]["camoufox/fresh"]["retry_started"] == 0
    assert top["modes"]["camoufox/fresh"]["retry_skipped"] == 1
    assert top["modes"]["camoufox/fresh"]["field_status_counts"]["reg_number"] == {"revealed": 1}
    assert REG not in (folder / "report.json").read_text()


def test_report_records_grid_coverage_and_executed_retry(tmp_path):
    attempt = _attempt(2, "revealed").model_copy(update={"rounds": [_round().model_copy(update={"grid": "4x4"})]})
    _, folder, _ = run(tmp_path, [Result(revealed(), [_attempt(1, "failed", "timeout"), attempt])],
                       "--reveals", "1")
    result = report(folder)
    assert result["retry_started"] == 1 and result["retry_skipped"] == 0
    assert result["grid_counts"] == {"3x3": 1, "4x4": 1}
    assert result["capture_durations_ms"] == [json.loads((folder / "report.json").read_text())["reveals"][0]["capture_duration_ms"]]


def test_report_keeps_skipped_listing_statuses_without_counting_them(tmp_path):
    _, folder, _ = run(tmp_path, [skipped(), ok()], "--reveals", "1")
    records = json.loads((folder / "report.json").read_text())["reveals"]
    assert [item["result"] for item in records] == ["skipped", "success_attempt_1"]
    assert records[0]["field_statuses"] == {"reg_number": "listed_in_full", "vin": "not_listed"}
    assert report(folder)["attempted"] == 1


def test_report_records_explicit_revision_and_deadline_policy(tmp_path):
    _, folder, _ = run(tmp_path, [ok()], "--reveals", "1", "--revision", "abc123")
    top = json.loads((folder / "report.json").read_text())
    assert top["revision"] == "abc123"
    assert top["deadline_policy"] == {"lease_seconds": 120.0, "completion_margin_seconds": 15.0}


def test_solver_hashes_do_not_require_a_manifest(tmp_path, monkeypatch):
    import hashlib
    from auto24_service.captcha import assets
    from auto24_service.captcha_benchmark import _solver_hashes

    (tmp_path / "model.bin").write_bytes(b"test model")
    expected = {"model.bin": hashlib.sha256(b"test model").hexdigest()}
    monkeypatch.setattr(assets, "PINNED_SOLVER_SHA256", expected)
    monkeypatch.setenv("CAPTCHA_SOLVER_DIR", str(tmp_path))
    assert _solver_hashes() == expected


def no_captcha():
    return Result(revealed(), [_attempt(1, "no_captcha_needed", rounds=0)])


class FakeContext:
    def __init__(self):
        self.pages = 0


class FakeShared:
    """Stands in for open_chromium_listing: counts opens and closes."""

    def __init__(self):
        self.opened, self.closed, self.context, self.urls = [], 0, FakeContext(), []
        self.profile_dirs = []

    def __call__(self, url, *, profile_dir=None, deadline=None, **kw):
        from contextlib import contextmanager

        @contextmanager
        def session():
            self.opened.append(url)
            self.profile_dirs.append(profile_dir)
            try:
                yield type("S", (), {"context": self.context})()
            finally:
                self.closed += 1

        return session()

    def opener_factory(self, session):
        from contextlib import contextmanager

        @contextmanager
        def opener(url, *, profile_dir=None, deadline=None):
            self.context.pages += 1
            self.urls.append(url)
            yield object()

        return opener


def _chromium_capture(queue, calls):
    def capture(url, *, solver, profile_dir=None, save_image=None, opener=None, **kw):
        calls.append((url, solver, opener))
        if opener is not None:
            with opener(url):
                pass
        return queue.pop(0)

    return capture


def _run_engines(tmp_path, *args, camoufox=(), chromium=(), shared=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    cam_calls, chr_calls = [], []
    shared = shared or FakeShared()
    out = tmp_path / "out"
    code = main(["--listings", str(listings), "--label", "t", "--out", str(out), *args],
                capture=_fake_capture(list(camoufox), cam_calls),
                chromium_capture=_chromium_capture(list(chromium), chr_calls),
                shared_open=shared, shared_opener_factory=shared.opener_factory,
                solver_loader=lambda d, use_lookup=False: object())
    return code, next(out.iterdir()), cam_calls, chr_calls, shared


def test_engine_both_runs_each_engine_on_the_same_listings(tmp_path):
    code, d, cam, chrom, _ = _run_engines(
        tmp_path, "--engine", "both", "--mode", "fresh", camoufox=[ok()] * 10, chromium=[ok()] * 10)
    assert code == 0
    assert [c[0] for c in cam] == [c[0] for c in chrom] and len(cam) == 10
    assert set(json.loads((d / "report.json").read_text())["modes"]) == {"camoufox/fresh", "chromium/fresh"}
    # The Chromium reveal is watched, not solved by the benchmark's solver.
    from auto24_service.captcha.extension_wait import EXTENSION
    assert all(c[1] is EXTENSION for c in chrom)


def test_shared_mode_reuses_one_session_and_counts_no_captcha_needed(tmp_path):
    code, d, _, chrom, shared = _run_engines(
        tmp_path, "--engine", "chromium", "--mode", "shared", "--reveals", "4",
        chromium=[ok(), no_captcha(), no_captcha(), no_captcha()])
    r = report(d, "chromium/shared")
    assert len(shared.opened) == 1 and shared.closed == 1
    assert shared.context.pages == 4
    assert r["attempted"] == 4 and r["no_captcha_needed"] == 3 and r["success_attempt_1"] == 4
    assert shared.profile_dirs[0] is not None and not Path(shared.profile_dirs[0]).exists()


def test_shared_results_never_decide_the_gate(tmp_path):
    code, d, *_ = _run_engines(
        tmp_path, "--engine", "chromium", "--mode", "fresh", "shared",
        chromium=[ok()] * 10 + [bad()] * 10)
    assert code == 0
    assert report(d, "chromium/fresh")["gate"] == "PASS"
    assert report(d, "chromium/shared")["gate"] == "NOT_GATED"
    assert report(d, "chromium/shared")["success_rate"] == 0.0
    code, d, *_ = _run_engines(
        tmp_path / "b", "--engine", "chromium", "--mode", "fresh", "shared",
        chromium=[bad()] * 10 + [ok()] * 10)
    assert code == 1 and report(d, "chromium/fresh")["gate"] == "FAIL"


def test_shared_mode_needs_the_chromium_engine(tmp_path, capsys):
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\n")
    assert main(["--listings", str(listings), "--label", "t", "--mode", "shared", "--out", str(tmp_path / "o")]) == 2
    assert "shared" in capsys.readouterr().err


def test_summary_prints_one_line_per_engine_and_mode(tmp_path, capsys):
    _run_engines(tmp_path, "--engine", "both", "--mode", "fresh", "shared",
                 camoufox=[ok()] * 10, chromium=[ok()] * 20)
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if re.match(r"(camoufox|chromium)/\w+: gate=", line)]
    assert [line.split(":")[0] for line in lines] == ["camoufox/fresh", "chromium/fresh", "chromium/shared"]
    assert "chromium/shared: gate=NOT_GATED attempted=10" in out and "no_captcha_needed=0" in out


def test_shared_session_failure_is_recorded_and_other_results_are_kept(tmp_path):
    from auto24_service.browser import CaptureError as RealCaptureError

    roots = []

    def failing_open(url, *, profile_dir=None, **kw):
        roots.append(profile_dir)
        assert Path(profile_dir).is_dir()
        raise RealCaptureError("browser_launch")

    shared = FakeShared()
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    out = tmp_path / "out"
    code = main(["--listings", str(listings), "--label", "t", "--out", str(out), "--engine", "chromium",
                 "--mode", "fresh", "shared"],
                chromium_capture=_chromium_capture([ok()] * 10, []), shared_open=failing_open,
                shared_opener_factory=shared.opener_factory)
    d = next(out.iterdir())
    assert code == 0 and report(d, "chromium/fresh")["gate"] == "PASS"
    r = report(d, "chromium/shared")
    assert r["attempted"] == 2 and r["capture_errors"] == {"browser_launch": 2}
    assert r["capture_errors_counted"] is True and r["gate"] == "NOT_GATED" and r["success_attempt_1"] == 0
    assert len(roots) == 2 and len(set(roots)) == 1 and not Path(roots[0]).exists()


def test_mode_both_is_an_alias_for_fresh_and_saved(tmp_path):
    code, d, _ = run(tmp_path, [ok()] * 20, mode="both")
    assert set(json.loads((d / "report.json").read_text())["modes"]) == {"camoufox/fresh", "camoufox/saved"}


def test_chromium_saved_keeps_no_profile_and_has_no_lookup_rate(tmp_path, monkeypatch):
    import tempfile

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setenv("CAPTCHA_LOOKUP_ENABLED", "true")
    code, d, _, chrom, _ = _run_engines(
        tmp_path, "--engine", "chromium", "--mode", "saved", "--keep-profile", chromium=[ok()] * 10)
    r = report(d, "chromium/saved")
    assert r["note"] is None and r["profile_kept"] is None and r["lookup_hit_rate"] is None


def _failing_shared(error, roots):
    def failing_open(url, *, profile_dir=None, **kw):
        roots.append(profile_dir)
        raise error

    return failing_open


def _main_with_shared(tmp_path, shared_open):
    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    return main(["--listings", str(listings), "--label", "t", "--out", str(tmp_path / "out"),
                 "--engine", "chromium", "--mode", "shared"],
                chromium_capture=_chromium_capture([], []), shared_open=shared_open,
                shared_opener_factory=FakeShared().opener_factory)


def test_extension_not_loaded_is_recorded_as_capture_errors(tmp_path):
    from auto24_service.browser import CaptureError as RealCaptureError

    roots = []
    code = _main_with_shared(tmp_path, _failing_shared(RealCaptureError("extension_not_loaded"), roots))
    d = next((tmp_path / "out").iterdir())
    r = report(d, "chromium/shared")
    assert code == 1 and r["attempted"] == 2 and r["capture_errors"] == {"extension_not_loaded": 2}
    assert not Path(roots[0]).exists()


def test_a_programming_error_opening_the_shared_session_propagates(tmp_path):
    import pytest

    roots = []
    with pytest.raises(TypeError):
        _main_with_shared(tmp_path, _failing_shared(TypeError("bad kwarg"), roots))
    assert len(roots) == 1 and not Path(roots[0]).exists()


def test_shared_session_opens_on_the_next_listing_when_the_first_cannot_open(tmp_path):
    from auto24_service.browser import CaptureError as RealCaptureError

    tried = []
    shared = FakeShared()

    def open_on_second(url, *, profile_dir=None, **kw):
        tried.append(url)
        if url.endswith("/a"):
            raise RealCaptureError("listing_changed")
        return shared(url, profile_dir=profile_dir, **kw)

    tmp_path.mkdir(parents=True, exist_ok=True)
    listings = tmp_path / "l.txt"
    listings.write_text("https://www.auto24.ee/a\nhttps://www.auto24.ee/b\n")
    out = tmp_path / "out"
    main(["--listings", str(listings), "--label", "t", "--out", str(out), "--engine", "chromium",
          "--mode", "shared", "--reveals", "2"],
         chromium_capture=_chromium_capture([ok()], []), shared_open=open_on_second,
         shared_opener_factory=shared.opener_factory)
    r = report(next(out.iterdir()), "chromium/shared")
    assert tried == ["https://www.auto24.ee/a", "https://www.auto24.ee/b"]
    assert shared.opened == ["https://www.auto24.ee/b"]
    assert r["attempted"] == 2 and r["capture_errors"] == {"listing_changed": 1} and r["success_attempt_1"] == 1


def test_no_gated_result_exits_non_zero_and_says_so(tmp_path, capsys):
    code, d, *_ = _run_engines(tmp_path, "--engine", "chromium", "--mode", "shared", chromium=[ok()] * 10)
    assert code == 1
    assert "no gated result" in capsys.readouterr().out


def _run_profile_mode(tmp_path, monkeypatch, mode, results):
    import tempfile
    from auto24_service.captcha_benchmark import _run_mode

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    paths = []
    fake = _fake_capture(list(results), [])

    def capture(url, **kwargs):
        path = kwargs.get("keep_profile")
        paths.append(path)
        if path is not None:
            assert path.is_dir()
        return fake(url, **kwargs)

    result = _run_mode("chromium", mode, ["https://www.auto24.ee/a"], len(results),
                       object(), capture, tmp_path / "images", True)
    return result, paths


def test_chromium_saved_reuses_one_profile(tmp_path, monkeypatch):
    result, paths = _run_profile_mode(tmp_path, monkeypatch, "saved", [ok()] * 3)
    assert paths[0] is not None and paths == [paths[0]] * 3
    assert not paths[0].parent.exists()
    assert result["profile_resets"] == 0


def test_chromium_saved_resets_after_a_block(tmp_path, monkeypatch):
    from auto24_service.browser import CaptureError as RealCaptureError

    result, paths = _run_profile_mode(
        tmp_path, monkeypatch, "saved", [RealCaptureError("access_blocked"), ok()])
    assert paths[0] is not None and paths[1] != paths[0]
    assert not paths[0].parent.exists()
    assert result["profile_resets"] == 1


def test_chromium_fresh_has_no_kept_profile(tmp_path, monkeypatch):
    result, paths = _run_profile_mode(tmp_path, monkeypatch, "fresh", [ok()] * 3)
    assert paths == [None] * 3
    assert "profile_resets" not in result


def test_chromium_saved_records_reveal_blocks_and_other_errors(tmp_path, monkeypatch):
    result, paths = _run_profile_mode(tmp_path, monkeypatch, "saved", [
        Result(failed(), [_attempt(1, "failed", "try_again_later")]),
        RuntimeError("fake error"), ok(),
    ])
    assert paths[0] is not None and paths[1] != paths[0] and paths[2] == paths[1]
    assert result["profile_resets"] == 1
    assert not paths[0].parent.exists()


def test_chromium_saved_resets_new_outcomes(tmp_path, monkeypatch):
    from auto24_service.browser import CaptureError as RealCaptureError
    result, paths = _run_profile_mode(tmp_path, monkeypatch, 'saved', [
        bad(), RealCaptureError('browser_launch'), RealCaptureError('extension_not_loaded'),
        RealCaptureError('temporary_failure'), RealCaptureError('temporary_failure'), ok(),
    ])
    assert result['profile_resets'] == 4
    assert paths[0] != paths[1] != paths[2] != paths[3]
    assert paths[3] == paths[4] and paths[4] != paths[5]


def test_capture_error_exception_classes_only(tmp_path, capsys):
    from auto24_service.browser import CaptureError as RealCaptureError
    cause = RuntimeError('private fake value 123ABC')
    wrapped = RealCaptureError('temporary_failure')
    wrapped.__cause__ = cause
    _, directory, _ = run(tmp_path, [wrapped, RealCaptureError('browser_launch')], "--reveals", "2")
    data = json.loads((directory / 'report.json').read_text())
    records = data['reveals']
    assert [r['capture_error_type'] for r in records] == ['RuntimeError', 'CaptureError']
    progress = capsys.readouterr().err
    assert 'capture error temporary_failure (RuntimeError)' in progress
    assert 'capture error browser_launch (CaptureError)' in progress
    markdown = (directory / 'report.md').read_text()
    assert 'error=temporary_failure (RuntimeError)' in markdown
    assert '123ABC' not in progress + markdown + json.dumps(data)


def test_capture_output_omits_missing_and_duplicate_error_classes(tmp_path, capsys):
    _, directory, _ = run(tmp_path, [RuntimeError('private'), ok()], "--reveals", "2")
    progress = capsys.readouterr().err
    markdown = (directory / 'report.md').read_text()
    assert 'capture error RuntimeError' in progress
    assert 'RuntimeError (RuntimeError)' not in progress
    assert 'error=None (None)' not in markdown
    assert 'error=error (RuntimeError)' in markdown
