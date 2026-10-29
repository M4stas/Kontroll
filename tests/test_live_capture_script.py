import importlib.util
from pathlib import Path

from auto24_service.contracts import AttemptRecord, RoundRecord, TileRecord

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sandbox-live-capture.py"


def test_offline_script_imports_without_listing_or_solver_dependencies():
    import subprocess
    import sys

    result = subprocess.run([sys.executable, "-c", """
import importlib.abc
import importlib.util
import sys

class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in {'camoufox', 'playwright', 'patchright', 'bs4', 'PIL', 'onnxruntime'}:
            raise ImportError(fullname)

sys.meta_path.insert(0, Block())
spec = importlib.util.spec_from_file_location('capture_script', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.path.insert(0, str(__import__('pathlib').Path(sys.argv[1]).parents[1] / 'tests'))
from fakesite.mnt import MntScenario, install_fake_mnt
""", str(_SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


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
    monkeypatch.setattr(module, "load_solver", lambda path, use_lookup=False: "solver")
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


def test_live_capture_script_accepts_engine_chromium(monkeypatch):
    import sys
    from types import SimpleNamespace
    module = _load()
    seen = {}
    def capture(url, **kwargs):
        seen.update(kwargs)
        return SimpleNamespace(registration=None, reveal_diagnostics=None)
    monkeypatch.setattr(module, "capture_listing", capture)
    monkeypatch.setattr(module, "verify_solver_dir", lambda *a: (_ for _ in ()).throw(AssertionError("solver verification")))
    monkeypatch.setattr(module, "load_solver", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("solver load")))
    monkeypatch.setattr(sys, "argv", ["x", "--engine", "chromium", "--url", "https://www.auto24.ee/soidukid/1"])
    assert module.main() == 0
    from auto24_service.browser_chromium import CHROMIUM_OPENER
    from auto24_service.captcha.extension_wait import EXTENSION
    assert seen["solver"] is EXTENSION
    assert seen["opener"] is CHROMIUM_OPENER
    assert "reveal" not in seen
    assert seen["engine"] == "chromium"


def test_offline_chromium_holds_real_session_for_thirty_seconds(monkeypatch):
    import sys
    from contextlib import contextmanager
    from types import SimpleNamespace
    import auto24_service.browser_chromium as chromium

    seen = {}
    @contextmanager
    def open_listing(url, *, setup):
        seen["url"] = url
        setup("context")
        yield SimpleNamespace(extension_loaded=True, page=SimpleNamespace(wait_for_timeout=lambda ms: seen.update(hold=ms)))
        seen["closed"] = True

    import auto24_service.mnt_lookup as mnt_lookup
    from auto24_service.mnt_lookup import LookupOutcome

    def lookup(kind, value, deadline, *, opener):
        seen["lookup"] = (kind, value)
        with opener(deadline=deadline) as session:
            seen["mnt_session"] = session
        return LookupOutcome(status="fetched", searched_by=kind, pdf=b"%PDF-")

    @contextmanager
    def open_session(*, site, setup, deadline):
        seen["site"] = site.main_frame_hosts
        setup("mnt-context")
        yield "mnt-session"

    monkeypatch.setattr(chromium, "open_chromium_listing", open_listing)
    monkeypatch.setattr(chromium, "open_chromium_session", open_session)
    monkeypatch.setattr(mnt_lookup, "lookup_background_check", lookup)
    monkeypatch.setitem(sys.modules, "fakesite", SimpleNamespace(
        LISTING_URL="fake-listing", Scenario=lambda: "scenario",
        install_fake_site=lambda context, scenario: seen.update(context=context, scenario=scenario),
    ))
    monkeypatch.setitem(sys.modules, "fakesite.mnt", SimpleNamespace(
        MntScenario=lambda: "mnt-scenario",
        install_fake_mnt=lambda context, scenario: seen.update(mnt_context=context, mnt_scenario=scenario),
    ))
    module = _load()
    monkeypatch.setattr(module, "load_solver", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("solver load")))
    monkeypatch.setattr(sys, "argv", ["x", "--engine", "chromium", "--offline"])
    assert module.main() == 0
    assert seen == dict(url="fake-listing", context="context", scenario="scenario", hold=30_000, closed=True,
                        lookup=("reg_number", "123ABC"), site=frozenset({"eteenindus.mnt.ee"}),
                        mnt_context="mnt-context", mnt_scenario="mnt-scenario", mnt_session="mnt-session")


def test_offline_invisible_runs_only_mnt_lookup(monkeypatch, capsys):
    import sys
    from contextlib import contextmanager
    from types import SimpleNamespace
    import auto24_service.browser_invisible as invisible
    import auto24_service.mnt_lookup as mnt
    from auto24_service.guard import MNT

    opened = []

    @contextmanager
    def open_session(*, site, setup, deadline, fake_hosts):
        assert site is MNT
        assert fake_hosts == ("eteenindus.mnt.ee",)
        setup("context")
        opened.append(deadline)
        yield "session"

    def lookup(kind, value, deadline, *, opener):
        assert kind == "reg_number" and value == "123ABC"
        with opener(deadline=deadline) as session:
            assert session == "session"
        return mnt.LookupOutcome(status="fetched", searched_by=kind, pdf=b"%PDF-")

    monkeypatch.setattr(invisible, "open_invisible_session", open_session)
    monkeypatch.setattr(mnt, "lookup_background_check", lookup)
    monkeypatch.setitem(sys.modules, "fakesite.mnt", SimpleNamespace(
        MntScenario=lambda: "scenario",
        install_fake_mnt=lambda context, scenario: opened.append((context, scenario)),
    ))
    module = _load()
    monkeypatch.setattr(module, "capture_listing", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("listing capture")))
    monkeypatch.setattr(module, "load_solver", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("solver load")))
    monkeypatch.setattr(sys, "argv", ["x", "--engine", "invisible", "--offline"])
    assert module.main() == 0
    assert len(opened) == 2 and opened[0] == ("context", "scenario")
    assert capsys.readouterr().out == "offline background check: fake MNT search fetched a fake PDF\n"
