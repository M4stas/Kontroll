import random
import time

import pytest

from auto24_service.contracts import TileRecord
from fakesite import LISTING_URL, Scenario, _jpeg, install_fake_site

pytest.importorskip("camoufox.sync_api")

from auto24_service.browser import open_listing  # noqa: E402
from auto24_service.captcha.recaptcha import solve_recaptcha  # noqa: E402
from auto24_service.captcha.solver import Decision  # noqa: E402


def decision(n, picks):
    return Decision([TileRecord(method="model", score=0.9 if i in picks else 0.1, selected=i in picks) for i in range(n)])


class StubSolver:
    def __init__(self, picks=(0, 4, 8), refill_picks=((1,),), unsupported=False):
        self.picks = set(picks)
        self.refill_picks = [set(p) for p in refill_picks]
        self.unsupported = unsupported
        self.grid_calls = []
        self.tile_calls = []

    def solve_grid(self, label, kind, image):
        self.grid_calls.append((label, kind, image))
        if self.unsupported:
            return None
        return decision(16 if kind == "4x4" else 9, self.picks)

    def solve_tiles(self, label, tiles):
        self.tile_calls.append((label, tiles))
        picks = self.refill_picks.pop(0) if self.refill_picks else set()
        return decision(len(tiles), {i for i in range(len(tiles)) if i in picks})


def run(scenario, solver=None, *, seconds=60, rounds_left=3, saved=None):
    solver = solver or StubSolver()
    log_box = {}

    def setup(context):
        log_box["log"] = install_fake_site(context, scenario)

    with open_listing(LISTING_URL, setup=setup) as session:
        session.page.click('.service-trigger[data-action="uv_regnr"]')
        started = time.monotonic()
        result = solve_recaptcha(
            session.page,
            solver,
            deadline=time.monotonic() + seconds,
            rounds_left=rounds_left,
            rng=random.Random(1),
            save_image=(lambda name, data: saved.append((name, data))) if saved is not None else None,
        )
        elapsed = time.monotonic() - started
        if result.passed:
            session.page.wait_for_function("document.querySelector('.field-reg_nr .value').textContent === '123ABC'")
    return result, log_box["log"], solver, elapsed


def test_checkbox_only_pass_records_no_rounds():
    result, log, solver, _ = run(Scenario(captcha="checkbox_only"))
    assert result.passed and result.reason is None and result.checkbox_only
    assert result.rounds == [] and solver.grid_calls == []


def test_3x3_round_clicks_selected_tiles_and_passes():
    result, log, solver, _ = run(Scenario(grid="3x3"))
    assert result.passed and not result.checkbox_only
    assert log.verifies == 1 and sorted(log.clicked_tiles[0]) == [0, 4, 8]
    (rnd,) = result.rounds
    assert rnd.grid == "3x3" and rnd.result == "solved" and sorted(rnd.tiles_clicked) == [0, 4, 8]
    assert rnd.label == "cars" and len(rnd.tiles) == 9 and rnd.duration_ms > 0


def test_dynamic_3x3_solves_refilled_tiles_in_the_same_round():
    solver = StubSolver(picks=(0, 4), refill_picks=((1,),))
    result, log, solver, _ = run(Scenario(grid="3x3_dynamic"), solver)
    assert result.passed
    assert log.verifies == 1 and sorted(log.clicked_tiles[0]) == [0, 4]
    # Refills of tiles 0 and 4 (pick the second, tile 4), then tile 4's new refill (no picks).
    assert [len(tiles) for _, tiles in solver.tile_calls] == [2, 1]
    assert solver.tile_calls[1][1][0] == _jpeg(100, 0 + 4 + 7)
    (rnd,) = result.rounds
    assert rnd.grid == "3x3_dynamic"
    assert sorted(rnd.tiles_clicked) == [0, 4, 4]


def test_4x4_round_passes():
    solver = StubSolver(picks=(5, 6, 9, 10))
    result, log, solver, _ = run(Scenario(grid="4x4"), solver)
    assert result.passed
    assert solver.grid_calls[0][1] == "4x4"
    assert sorted(log.clicked_tiles[0]) == [5, 6, 9, 10]
    assert result.rounds[0].grid == "4x4"


def test_incorrect_rounds_retry_until_three_then_stop():
    result, log, _, _ = run(Scenario(incorrect_rounds=5))
    assert not result.passed and result.reason == "captcha_rounds_exhausted"
    assert log.verifies == 3
    assert [r.result for r in result.rounds] == ["incorrect"] * 3
    assert result.stage == "captcha_round"


def test_try_again_later_ends_immediately():
    result, log, solver, _ = run(Scenario(try_again_later=True))
    assert not result.passed and result.reason == "try_again_later"
    assert log.verifies == 0 and solver.grid_calls == []
    assert result.stage == "captcha_state" and result.error_type is None


def test_hung_checkbox_times_out():
    result, _, _, elapsed = run(Scenario(hang_checkbox=True), seconds=5)
    assert result.reason == "timeout" and not result.passed
    assert result.stage == "captcha_state" and result.error_type is None
    assert elapsed < 7


def test_unknown_label_ends_with_label_unsupported():
    result, log, solver, _ = run(Scenario(label_id=None, label_name="Giraffe", instruction="Select all images with giraffes"))
    assert result.reason == "label_unsupported"
    assert log.verifies == 0 and solver.grid_calls == []
    assert result.rounds[0].result == "label_unsupported" and result.rounds[0].label is None


def test_label_comes_from_reload_id_not_text():
    result, _, solver, _ = run(
        Scenario(label_id="/m/0k4j", label_name=None, instruction="Valige kõik pildid, millel on kaelkirjakud")
    )
    assert result.passed
    assert result.rounds[0].label_source == "id" and result.rounds[0].label == "cars"
    assert solver.grid_calls[0][0] == "cars"


def test_images_come_from_network_responses():
    saved = []
    result, _, solver, _ = run(Scenario(grid="3x3"), saved=saved)
    assert result.passed
    assert solver.grid_calls[0][2] == _jpeg(300, 0)
    assert [data for _, data in saved] == [_jpeg(300, 0)]


def test_solver_error_ends_with_browser_error():
    class Broken(StubSolver):
        def solve_grid(self, label, kind, image):
            raise OSError("cannot identify image file")

    result, log, _, _ = run(Scenario(), Broken())
    assert not result.passed and result.reason == "browser_error"
    assert result.error_type == "OSError" and result.stage == "captcha_round"
    assert result.rounds[-1].stage == "solver"
    assert log.verifies == 0
    assert all(r.result != "solved" for r in result.rounds)


def test_widget_removed_without_token_is_browser_error():
    result, log, solver, elapsed = run(Scenario(remove_widget=True), seconds=20)
    assert not result.passed and result.reason == "browser_error"
    assert result.widget_gone and result.stage == "captcha_state"
    assert solver.grid_calls == []
    assert elapsed < 10


def test_widget_removed_on_a_checkbox_pass_is_reported_as_gone_not_passed():
    result, log, solver, _ = run(Scenario(captcha="checkbox_only", vanish_on_pass=True), seconds=20)
    assert not result.passed and result.reason == "browser_error"
    assert result.widget_gone and result.checkbox_only and solver.grid_calls == []


@pytest.mark.parametrize("shows_incorrect", [True, False])
def test_verify_token_with_challenge_still_open_plays_the_next_round(shows_incorrect):
    scenario = Scenario(decoy_token_rounds=1, decoy_shows_incorrect=shows_incorrect)
    result, log, _, _ = run(scenario)
    assert result.passed and not result.widget_gone
    assert log.verifies == 2 and log.reloads == 2
    assert [r.result for r in result.rounds] == ["incorrect", "solved"]


def test_earlier_ticked_widget_is_no_evidence_for_a_removed_second_widget():
    scenario = Scenario(captcha="checkbox_only", vin_needs_captcha=True, second_widget_mode="vanish")
    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, scenario)) as session:
        page = session.page
        page.click('.service-trigger[data-action="uv_regnr"]')
        first = solve_recaptcha(page, StubSolver(), deadline=time.monotonic() + 20, rounds_left=3, rng=random.Random(1))
        assert first.passed and first.checkbox_only
        page.wait_for_function("document.querySelector('.field-reg_nr .value').textContent === '123ABC'")
        page.click('.service-trigger[data-action="uv_vin"]')
        second = solve_recaptcha(page, StubSolver(), deadline=time.monotonic() + 20, rounds_left=3, rng=random.Random(1))
    assert not second.passed and second.reason == "browser_error"


def test_incorrect_verify_without_reload_plays_next_round():
    result, log, _, _ = run(Scenario(incorrect_inline=True, incorrect_rounds=1))
    assert result.passed and log.verifies == 2 and log.reloads == 1
    assert [r.stage for r in result.rounds] == ["done", "done"] and result.stage == "done"
    assert [r.result for r in result.rounds] == ["incorrect", "solved"]
    assert result.rounds[1].label_source == "id"


def test_select_more_refusal_plays_next_round():
    result, log, _, _ = run(Scenario(select_more_rounds=1))
    assert result.passed and log.verifies == 1
    assert [r.result for r in result.rounds] == ["incorrect", "solved"]
    assert result.rounds[1].label_source == "instruction" and result.rounds[1].label == "cars"


def test_browser_error_mid_round_is_recorded():
    class Closing(StubSolver):
        page = None

        def solve_grid(self, label, kind, image):
            decision = super().solve_grid(label, kind, image)
            self.page.close()
            return decision

    solver = Closing()
    log_box = {}
    with open_listing(LISTING_URL, setup=lambda c: log_box.setdefault("log", install_fake_site(c, Scenario()))) as s:
        s.page.click('.service-trigger[data-action="uv_regnr"]')
        solver.page = s.page
        result = solve_recaptcha(s.page, solver, deadline=time.monotonic() + 30, rounds_left=3, rng=random.Random(1))
    assert result.reason == "browser_error" and not result.passed
    assert [r.result for r in result.rounds] == ["incorrect"]


def test_deadline_inside_capped_wait_reports_timeout():
    class Stalling(StubSolver):
        page = None
        deadline = 0.0

        def solve_grid(self, label, kind, image):
            frame = next(f for f in self.page.frames if "/bframe" in f.url)
            frame.evaluate("document.getElementById('recaptcha-verify-button').remove()")
            # Leave enough time for the pre-verify delay, then expire inside the button wait.
            time.sleep(max(0, self.deadline - time.monotonic() - 1.4))
            return super().solve_grid(label, kind, image)

    solver = Stalling(picks=())
    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as s:
        s.page.click('.service-trigger[data-action="uv_regnr"]')
        solver.page = s.page
        solver.deadline = time.monotonic() + 20
        result = solve_recaptcha(s.page, solver, deadline=solver.deadline, rounds_left=3, rng=random.Random(1))
    assert result.reason == "timeout" and not result.passed
    assert [r.result for r in result.rounds] == ["timeout"]
    assert result.rounds[0].stage == "verify_click"
    assert result.error_type == "TimeoutError" and result.stage == "captcha_round"


def _debug_run(scenario, folder):
    from auto24_service.captcha.debug import DebugRecorder

    recorder = DebugRecorder(folder)
    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, scenario)) as session:
        session.page.click('.service-trigger[data-action="uv_regnr"]')
        result = solve_recaptcha(
            session.page, StubSolver(), deadline=time.monotonic() + 60, rounds_left=3,
            rng=random.Random(1), debug=lambda e, p, info: recorder(e, p, {**info, "attempt": 1}),
        )
    return result


def test_debug_writes_screenshots_and_events_without_query_strings(tmp_path):
    import json

    result = _debug_run(Scenario(grid="3x3"), tmp_path)
    assert result.passed
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    events = [r["event"] for r in lines]
    assert events[0] == "checkbox_clicked" and "round_start" in events and events[-1] == "captcha_end"
    assert lines[-1]["reason"] == "passed"
    for r in lines:
        assert (tmp_path / r["screenshot"]).read_bytes()[:4] == b"\x89PNG"
        assert r["screenshot"].startswith(f"{r['n']:02d}-a1-")
        for key in ("t", "attempt", "frames", "bframe", "anchor", "doscaptcha", "click_rel_anchor", "matched"):
            assert key in r, key
    first = lines[0]
    assert set(first["anchor"]) == {"aria_checked", "classes", "error_msg", "loading"}
    assert first["matched"]["anchor"].endswith("/anchor") and first["click_rel_anchor"] is not None
    assert set(lines[1]["bframe"]) == {"exists", "visible", "box"}
    text = (tmp_path / "events.jsonl").read_text()
    assert "?" not in text and "#" not in text and "123ABC" not in text


def test_debug_off_changes_nothing_and_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result, _, _, _ = run(Scenario(grid="3x3"))
    assert result.passed and len(result.rounds) == 1
    assert list(tmp_path.iterdir()) == []


def test_4x4_label_id_is_read_when_pmeta_nests_the_label_list():
    pmeta = ["pmeta", None, ["/m/04_sv", None, 4, 4, 4, None, "motorcycle"]]
    scenario = Scenario(grid="4x4", pmeta=pmeta, instruction="Select all squares with motorcycles")
    result, log, solver, _ = run(scenario, StubSolver(picks=(5, 6, 9, 10)))
    assert result.passed
    (rnd,) = result.rounds
    assert (rnd.grid, rnd.label_id, rnd.label, rnd.label_source) == ("4x4", "/m/04_sv", "motorcycles", "id")
    assert sorted(log.clicked_tiles[0]) == [5, 6, 9, 10]


def test_grid_size_hint_that_disagrees_with_the_dom_does_not_spin():
    # Challenge data says 4x4, the DOM shows 3x3: the DOM wins after the image wait.
    pmeta = ["pmeta", ["/m/01lynh", None, 4, 4, 4, None, "stairs"]]
    result, log, solver, elapsed = run(Scenario(grid="3x3", pmeta=pmeta), seconds=60)
    assert result.passed
    (rnd,) = result.rounds
    assert (rnd.grid, rnd.label, rnd.label_source) == ("3x3", "stairs", "id")
    assert solver.grid_calls[0][:2] == ("stairs", "3x3")
    assert elapsed < 30


def test_grid_that_is_neither_3x3_nor_4x4_ends_fast_as_unsupported():
    result, log, solver, elapsed = run(Scenario(grid="3x3", dom_size=2), seconds=60)
    assert not result.passed and result.reason == "label_unsupported"
    (rnd,) = result.rounds
    assert (rnd.result, rnd.stage, rnd.label_id) == ("label_unsupported", "tiles", "/m/0k4j")
    assert log.verifies == 0 and solver.grid_calls == []
    assert elapsed < 30


def test_debug_records_challenge_shape_and_selection(tmp_path):
    import json

    result = _debug_run(Scenario(grid="3x3"), tmp_path)
    assert result.passed
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    by_event = {r["event"]: r for r in lines}
    data = by_event["challenge_data"]
    assert data["pmeta_shape"] == ["str", ["/m/0k4j", None, 3, 3, 3, None, "str"]]
    assert data["kind"] == "imageselect" and data["size_hint"] == 3
    before = by_event["before_verify"]
    assert before["cells"] == 9 and before["picked"] == [0, 4, 8] and before["dom_selected"] == [0, 4, 8]
    after = by_event["verify_result"]
    assert after["outcome"] == "solved" and after["incorrect_shown"] is False
    assert "Car" not in (tmp_path / "events.jsonl").read_text()


def test_empty_grid_longer_than_the_image_wait_still_solves():
    # After a failed verify the table shows 0 cells for 7.5 s, then a 3x3 grid.
    scenario = Scenario(grid="3x3", incorrect_rounds=1, rebuild_delay_ms=7500)
    result, log, solver, elapsed = run(scenario, seconds=60)
    assert result.passed
    assert [r.result for r in result.rounds] == ["incorrect", "solved"]
    assert elapsed > 7.5  # the empty phase happened
    assert log.verifies == 2


def test_verify_result_probe_failure_keeps_a_solved_round(tmp_path, monkeypatch):
    import json

    from auto24_service.captcha import recaptcha

    original = recaptcha._Driver.wait_for_verify

    def then_frame_gone(self, frame, tiles, before):
        outcome = original(self, frame, tiles, before)

        def gone(*args, **kwargs):
            raise RuntimeError("frame was detached")

        monkeypatch.setattr(self, "visible", gone)  # the widget is removed right after the pass
        return outcome

    monkeypatch.setattr(recaptcha._Driver, "wait_for_verify", then_frame_gone)
    result = _debug_run(Scenario(grid="3x3"), tmp_path)
    assert result.passed and result.reason is None
    assert [r.result for r in result.rounds] == ["solved"]
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    verify = next(r for r in lines if r["event"] == "verify_result")
    assert verify["incorrect_shown"] is None and verify["select_more_shown"] is None


def test_debug_records_label_lists_and_label_conflict(tmp_path):
    import json

    pmeta = ["pmeta", None, ["/m/04_sv", None, 4, 4, 4, None, "x"], [["/m/0199g"]]]
    scenario = Scenario(grid="4x4", pmeta=pmeta, instruction="Select all squares with bicycles")
    result = _debug_run(scenario, tmp_path)
    assert result.passed
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    by_event = {r["event"]: r for r in lines}
    assert by_event["challenge_data"]["id_lists"] == 2
    resolved = by_event["label_resolved"]
    assert (resolved["label_source"], resolved["id_label"], resolved["instruction_label"]) == (
        "id", "motorcycles", "bicycles")
    assert resolved["label_conflict"] is True


def test_pass_that_parks_the_challenge_offscreen_without_a_tick_is_solved():
    # The token posts late so the widget is still on the page when the frame parks.
    scenario = Scenario(pass_hides_bframe="offscreen", pass_ticks_anchor=False, pass_submit_delay_ms=2000)
    result, log, _, _ = run(scenario)
    assert result.passed and not result.widget_gone and log.verifies == 1
    assert [r.result for r in result.rounds] == ["solved"]


def test_widget_removed_after_verify_is_gone_not_solved():
    result, log, _, _ = run(Scenario(verify_vanish="with_value"), seconds=30)
    assert not result.passed and result.reason == "browser_error" and result.widget_gone
    assert not result.checkbox_only and log.verifies == 1
    assert [(r.result, r.stage) for r in result.rounds] == [("incorrect", "verify_wait")]


class _Stub:
    """Minimal page, frame and locator stand-in for state reads."""

    def __init__(self, **attrs):
        self.__dict__.update(attrs)


def _stub_driver(box=None, checked="false"):
    from auto24_service.captcha.recaptcha import _Driver

    frame_el = _Stub(is_visible=lambda: True, bounding_box=lambda timeout=None: box)
    page = _Stub(
        url=LISTING_URL, is_closed=lambda: False, evaluate=lambda *a: None, frames=[],
        locator=lambda sel: _Stub(count=lambda: 1, last=frame_el),
    )
    driver = _Driver(page, StubSolver(), time.monotonic() + 30, 3, time.monotonic, random.Random(1), None)
    driver.anchor_frame = _Stub(
        is_detached=lambda: False,
        locator=lambda sel: _Stub(get_attribute=lambda name, timeout=None: checked),
    )
    return driver


def test_open_challenge_on_a_scrolled_page_still_reads_as_open():
    assert _stub_driver(box={"x": 10, "y": -700, "width": 400, "height": 580}).challenge_visible()
    assert not _stub_driver(box={"x": 1, "y": -9999, "width": 400, "height": 580}).challenge_visible()
    assert not _stub_driver(box={"x": 10, "y": 10, "width": 0, "height": 0}).challenge_visible()


def test_checkbox_that_unticks_after_a_tick_is_not_a_pass():
    driver = _stub_driver(checked="false")
    driver.anchor_was_checked = True  # an earlier read saw the tick
    assert driver.anchor_checked() is False and not driver.passed()
    assert not driver.anchor_was_checked
