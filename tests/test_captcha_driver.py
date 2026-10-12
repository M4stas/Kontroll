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


def test_try_again_later_ends_immediately():
    result, log, solver, _ = run(Scenario(try_again_later=True))
    assert not result.passed and result.reason == "try_again_later"
    assert log.verifies == 0 and solver.grid_calls == []


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
    assert not result.checkbox_only and solver.grid_calls == []
    assert elapsed < 10


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
