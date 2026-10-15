import time
from contextlib import contextmanager

import pytest

from auto24_service.contracts import TileRecord
from fakesite import LISTING_URL, Scenario, install_fake_site

from auto24_service.captcha.reveal import check_reg_number, prefix_matches, vin_format


def test_value_checks_accept_custom_plates_and_old_vins():
    for good in ("123ABC", "ABBA 1", "mÕÄ-1"):
        assert check_reg_number(good), good
    for bad in ("", "x" * 21, "Reg. number: näita", "АВС123"):
        assert not check_reg_number(bad), bad
    assert vin_format("WVWZZZ1KZAW000001") == "standard"
    assert vin_format("123456") == "nonstandard"
    assert vin_format("WVWZZZ1KZAW00000O") == "nonstandard"
    assert vin_format("WVW ZZZ") is None
    assert vin_format("WVWZZZ1KZAW0000012") is None  # 18 characters
    assert vin_format("ŠVWZZZ") is None
    assert prefix_matches("123...", "123ABC") == "passed"
    assert prefix_matches("123...", "123 abc") == "passed"
    assert prefix_matches("ABB...", "ABBA1") == "passed"
    assert prefix_matches("123...", "456DEF") == "failed"
    assert prefix_matches(None, "X") == "skipped"


camoufox = pytest.importorskip("camoufox.sync_api")

from auto24_service.browser import CaptureError, open_listing  # noqa: E402
from auto24_service.captcha.reveal import reveal_registration  # noqa: E402
from auto24_service.captcha.solver import Decision  # noqa: E402


def decision(n, picks):
    return Decision([TileRecord(method="model", score=0.9 if i in picks else 0.1, selected=i in picks) for i in range(n)])


class StubSolver:
    def __init__(self, supported_calls=None):
        self.supported_calls = supported_calls  # None: always supported
        self.grid_calls = 0

    def solve_grid(self, label, kind, image):
        self.grid_calls += 1
        if self.supported_calls is not None and self.grid_calls > self.supported_calls:
            return None
        return decision(16 if kind == "4x4" else 9, {0, 4, 8})

    def solve_tiles(self, label, tiles):
        return decision(len(tiles), set())


def run(first, second=None, solver=None, **kwargs):
    """Reveal on a fake listing; `second` is the scenario the retry session gets."""
    logs = []
    reopened = []

    @contextmanager
    def reopen():
        reopened.append(True)
        with open_listing(LISTING_URL, setup=lambda c: logs.append(install_fake_site(c, second or first))) as s:
            yield s

    with open_listing(LISTING_URL, setup=lambda c: logs.append(install_fake_site(c, first))) as session:
        outcome = reveal_registration(session, reopen, solver or StubSolver(), **kwargs)
        assert not session.page.is_closed()
    return outcome, logs, reopened


def clicked(log, action):
    return any(f"q={action}" in url for url in log.requests)


def test_reveal_with_challenge_returns_both_values():
    outcome, logs, reopened = run(Scenario())
    reg = outcome.registration
    assert (reg.reg_number, reg.reg_number_status) == ("123ABC", "revealed")
    assert (reg.vin, reg.vin_status, reg.vin_format) == ("WVWZZZ1KZAW000001", "revealed", "standard")
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.attempt == 1 and attempt.outcome == "revealed" and attempt.reason is None
    assert attempt.checkbox_only is False and len(attempt.rounds) == 1
    assert attempt.prefix_check == {"reg_number": "passed", "vin": "passed"}
    assert logs[0].verifies == 1 and not reopened


def test_no_captcha_needed_outcome():
    outcome, _, _ = run(Scenario(captcha="none"))
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == "no_captcha_needed" and attempt.checkbox_only is None and attempt.rounds == []
    assert outcome.registration.reg_number_status == "revealed"
    assert outcome.registration.vin_status == "revealed"


EXPECTED = {"hidden": "revealed", "full": "listed_in_full", "missing": "not_listed"}


@pytest.mark.parametrize("reg", ["hidden", "full", "missing"])
@pytest.mark.parametrize("vin", ["hidden", "full", "missing"])
def test_row_combinations_set_statuses(reg, vin):
    outcome, logs, _ = run(Scenario(reg=reg, vin=vin, captcha="checkbox_only"))
    r = outcome.registration
    diag = [(a.reason, a.duration_ms, a.checkbox_only, a.outcome) for a in outcome.diagnostics.attempts]
    assert (r.reg_number_status, r.vin_status) == (EXPECTED[reg], EXPECTED[vin]), diag
    assert (r.reg_number == "123ABC") == (reg != "missing")
    assert (r.vin == "WVWZZZ1KZAW000001") == (vin != "missing")
    assert clicked(logs[0], "uv_regnr") == (reg == "hidden")
    assert clicked(logs[0], "uv_vin") == (vin == "hidden")
    attempts = outcome.diagnostics.attempts
    if "hidden" in (reg, vin):
        assert len(attempts) == 1, [(a.reason, a.duration_ms, a.checkbox_only) for a in attempts]
        (attempt,) = attempts
        assert attempt.outcome == "revealed" and attempt.checkbox_only is True
    else:
        assert attempts == []


def test_vin_row_with_only_a_history_link_is_not_listed():
    outcome, logs, reopened = run(Scenario(reg="full", vin="link_only", captcha="checkbox_only"))
    r = outcome.registration
    assert (r.reg_number_status, r.vin, r.vin_status, r.vin_format) == ("listed_in_full", None, "not_listed", None)
    assert outcome.diagnostics.attempts == [] and not reopened
    assert not clicked(logs[0], "uv_vin")


def test_hidden_reg_with_link_only_vin_reveals_reg_in_one_attempt():
    outcome, logs, reopened = run(Scenario(vin="link_only", captcha="checkbox_only"))
    r = outcome.registration
    assert (r.reg_number, r.reg_number_status) == ("123ABC", "revealed")
    assert (r.vin, r.vin_status) == (None, "not_listed")
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == "revealed" and attempt.reason is None
    assert clicked(logs[0], "uv_regnr") and not clicked(logs[0], "uv_vin") and not reopened


def test_full_vin_next_to_history_link_is_listed_in_full():
    outcome, logs, _ = run(Scenario(reg="full", vin="full_with_link"))
    r = outcome.registration
    assert (r.vin, r.vin_status, r.vin_format) == ("WVWZZZ1KZAW000001", "listed_in_full", "standard")
    assert outcome.diagnostics.attempts == [] and outcome.diagnostics.initial_rejected == []


@pytest.mark.parametrize("which", ["reg", "vin"])
def test_shown_value_failing_check_is_unavailable_without_attempts(which):
    scenario = Scenario(**{"reg": "full", "vin": "full", which: "invalid"})
    outcome, logs, reopened = run(scenario)
    r = outcome.registration
    name = "reg_number" if which == "reg" else "vin"
    assert getattr(r, name) is None and getattr(r, f"{name}_status") == "unavailable"
    assert outcome.diagnostics.attempts == [] and not reopened
    assert outcome.diagnostics.initial_rejected == [name]
    assert "N/A" not in outcome.diagnostics.model_dump_json()
    assert not clicked(logs[0], "uv_regnr") and not clicked(logs[0], "uv_vin")


def test_first_attempt_fails_then_retry_succeeds():
    solver = StubSolver(supported_calls=1)  # VIN challenge in attempt 1 gets an unsupported label
    outcome, logs, reopened = run(Scenario(vin_needs_captcha=True), Scenario(captcha="none"), solver=solver)
    first, second = outcome.diagnostics.attempts
    assert (first.attempt, first.outcome, first.reason) == (1, "failed", "label_unsupported")
    assert first.prefix_check == {"reg_number": "passed"}
    assert (second.attempt, second.outcome) == (2, "no_captcha_needed")
    assert second.prefix_check == {"vin": "passed"}
    assert reopened == [True] and len(logs) == 2
    assert not clicked(logs[1], "uv_regnr") and clicked(logs[1], "uv_vin")
    assert outcome.registration.reg_number_status == "revealed"
    assert outcome.registration.vin_status == "revealed"


def test_two_failed_attempts_mark_fields_unavailable_with_reasons():
    outcome, logs, reopened = run(Scenario(), solver=StubSolver(supported_calls=0))
    reasons = [(a.attempt, a.outcome, a.reason) for a in outcome.diagnostics.attempts]
    assert reasons == [(1, "failed", "label_unsupported"), (2, "failed", "label_unsupported")]
    r = outcome.registration
    assert (r.reg_number, r.reg_number_status, r.vin, r.vin_status, r.vin_format) == (
        None, "unavailable", None, "unavailable", None
    )
    assert reopened == [True]


def test_reopen_capture_error_fails_attempt_two_with_listing_changed():
    @contextmanager
    def reopen():
        raise CaptureError("listing_gone")
        yield

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as session:
        outcome = reveal_registration(session, reopen, StubSolver(supported_calls=0))
    assert [a.reason for a in outcome.diagnostics.attempts] == ["label_unsupported", "listing_changed"]


def test_attempt_two_budget_includes_a_hanging_reopen():
    @contextmanager
    def reopen():
        time.sleep(60)
        yield None

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as session:
        outcome = reveal_registration(session, reopen, StubSolver(supported_calls=0), attempt_seconds=10)
        first, second = outcome.diagnostics.attempts
    assert first.reason == "label_unsupported"
    assert (second.attempt, second.outcome, second.reason) == (2, "failed", "timeout")
    assert 10_000 <= second.duration_ms < 20_000
    assert outcome.registration.reg_number_status == "unavailable"


def test_auto24_refusal_marks_unavailable_and_keeps_listing():
    outcome, _, _ = run(Scenario(refuse_reveal=True))
    assert [a.reason for a in outcome.diagnostics.attempts] == ["value_not_found", "value_not_found"]
    assert outcome.registration.reg_number_status == "unavailable"
    assert outcome.registration.vin_status == "unavailable"


def test_prefix_mismatch_rejects_value():
    outcome, _, _ = run(Scenario(captcha="none", reg_value="999XYZ", reg_prefix="123..."))
    first, second = outcome.diagnostics.attempts
    assert first.reason == "prefix_mismatch"
    assert first.prefix_check == {"reg_number": "failed", "vin": "passed"}
    assert second.reason == "prefix_mismatch" and second.prefix_check == {"reg_number": "failed"}
    assert outcome.registration.reg_number_status == "unavailable"
    assert outcome.registration.vin_status == "revealed"


def test_dom_and_json_value_must_agree():
    outcome, _, _ = run(Scenario(captcha="none", reg_page_value="456DEF"))
    assert [a.reason for a in outcome.diagnostics.attempts] == ["value_rejected", "value_rejected"]
    assert outcome.registration.reg_number_status == "unavailable"
    assert outcome.registration.vin_status == "revealed"


def test_force_failure_records_two_widget_not_found_attempts_without_clicking():
    outcome, logs, reopened = run(Scenario(), force_failure=True)
    assert [(a.attempt, a.outcome, a.reason) for a in outcome.diagnostics.attempts] == [
        (1, "failed", "widget_not_found"),
        (2, "failed", "widget_not_found"),
    ]
    assert not reopened and len(logs) == 1
    assert not clicked(logs[0], "uv_regnr") and not clicked(logs[0], "uv_vin")
    assert outcome.registration.reg_number_status == "unavailable"


def test_blocked_google_request_is_recorded_on_the_attempt():
    outcome, _, _ = run(Scenario(extra_request="https://www.google.com/js/bg/x.js"))
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == "revealed"
    assert attempt.blocked_requests == ["www.google.com/js/"]


def test_values_never_appear_in_diagnostics():
    outcome, _, _ = run(Scenario())
    text = outcome.diagnostics.model_dump_json()
    assert outcome.registration.reg_number_status == "revealed"
    for value in ("123ABC", "WVWZZZ1KZAW000001"):
        assert value not in text and value.casefold() not in text.casefold()


def test_deadline_shortens_attempt_one_and_skips_attempt_two():
    # A slow CAPTCHA (the checkbox never answers, so the attempt waits out its budget) must
    # finish by the lease-derived deadline, and attempt 2 is recorded, not started.
    @contextmanager
    def reopen():
        raise AssertionError("attempt 2 must not start")
        yield

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario(hang_checkbox=True))) as session:
        deadline = time.monotonic() + 12
        outcome = reveal_registration(session, reopen, StubSolver(), deadline=deadline)
        finished = time.monotonic()
    first, second = outcome.diagnostics.attempts
    assert finished <= deadline + 1
    assert first.duration_ms <= 12_500
    assert (second.attempt, second.outcome, second.reason) == (2, "failed", "timeout")
    assert outcome.registration.reg_number_status == "unavailable"


def test_deadline_too_close_records_timeouts_without_clicking():
    @contextmanager
    def reopen():
        raise AssertionError("attempt 2 must not start")
        yield

    logs = []
    with open_listing(LISTING_URL, setup=lambda c: logs.append(install_fake_site(c, Scenario()))) as session:
        outcome = reveal_registration(session, reopen, StubSolver(), deadline=time.monotonic() + 5)
    assert [(a.attempt, a.reason) for a in outcome.diagnostics.attempts] == [(1, "timeout"), (2, "timeout")]
    assert not clicked(logs[0], "uv_regnr")


def test_reopen_exception_records_only_its_class_name():
    @contextmanager
    def reopen():
        raise RuntimeError("https://www.auto24.ee/x?token=SECRET")
        yield

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as session:
        outcome = reveal_registration(session, reopen, StubSolver(supported_calls=0))
    first, second = outcome.diagnostics.attempts
    assert first.error_type is None and first.stage == "captcha_round"
    assert (second.reason, second.error_type, second.stage) == ("browser_error", "RuntimeError", "reopen")
    assert "SECRET" not in outcome.diagnostics.model_dump_json()


def test_attempt_two_record_survives_a_failing_browser_close():
    @contextmanager
    def reopen():
        with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as s:
            yield s
        raise RuntimeError("close failed")

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, Scenario())) as session:
        outcome = reveal_registration(session, reopen, StubSolver(supported_calls=0))
    second = outcome.diagnostics.attempts[1]
    assert (second.reason, len(second.rounds), second.error_type) == ("label_unsupported", 1, None)


def test_page_exception_in_attempt_sets_error_type():
    class Broken(StubSolver):
        def solve_grid(self, label, kind, image):
            raise ValueError("bad image https://www.google.com/recaptcha/api2/payload?p=SECRET")

    outcome, _, _ = run(Scenario(), solver=Broken())
    for attempt in outcome.diagnostics.attempts:
        assert (attempt.reason, attempt.error_type) == ("browser_error", "ValueError")
        assert attempt.rounds[-1].stage == "solver"
    assert "SECRET" not in outcome.diagnostics.model_dump_json()


def test_reveal_debug_records_trigger_and_attempt_end(tmp_path):
    import json

    from auto24_service.captcha.debug import DebugRecorder

    outcome, _, _ = run(Scenario(captcha="checkbox_only"), debug=DebugRecorder(tmp_path))
    assert outcome.registration.reg_number_status == "revealed"
    lines = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    events = [r["event"] for r in lines]
    assert events[0] == "trigger_clicked" and events[-1] == "attempt_end"
    assert "checkbox_clicked" in events and "captcha_end" in events
    assert all(r["attempt"] == 1 for r in lines)
    assert len(list(tmp_path.glob("*.png"))) == len(lines)


def test_successful_attempt_two_survives_a_failing_browser_close():
    class SecondCallUnsupported(StubSolver):
        def solve_grid(self, label, kind, image):
            self.grid_calls += 1
            return None if self.grid_calls == 2 else decision(16 if kind == "4x4" else 9, {0, 4, 8})

    scenario = Scenario(vin_needs_captcha=True)

    @contextmanager
    def reopen():
        with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, scenario)) as s:
            yield s
        raise RuntimeError("close failed")

    with open_listing(LISTING_URL, setup=lambda c: install_fake_site(c, scenario)) as session:
        outcome = reveal_registration(session, reopen, SecondCallUnsupported())
    first, second = outcome.diagnostics.attempts
    assert first.reason == "label_unsupported"
    assert (second.outcome, second.reason, second.stage, second.error_type) == ("revealed", None, "done", None)
    reg = outcome.registration
    assert (reg.reg_number_status, reg.vin_status) == ("revealed", "revealed")
    assert reg.vin == "WVWZZZ1KZAW000001"


def test_refused_value_records_value_wait_stage():
    outcome, _, _ = run(Scenario(refuse_reveal=True))
    assert [a.stage for a in outcome.diagnostics.attempts] == ["value_wait", "value_wait"]


def test_escape_while_reading_the_row_records_trigger_stage(monkeypatch):
    import auto24_service.captcha.reveal as reveal

    real = reveal._read_row
    calls = {"n": 0}

    def flaky(page, f):
        calls["n"] += 1
        if calls["n"] > 2:  # the two initial-state reads pass
            raise RuntimeError("row read failed")
        return real(page, f)

    monkeypatch.setattr(reveal, "_read_row", flaky)
    outcome, _, _ = run(Scenario())
    for attempt in outcome.diagnostics.attempts:
        assert (attempt.reason, attempt.error_type, attempt.stage) == ("browser_error", "RuntimeError", "trigger")


def test_stage_stays_with_the_failure_that_became_the_reason(monkeypatch):
    from auto24_service.captcha import reveal

    real = reveal._Attempt.reveal

    def patched(self, f):
        if f.name == "vin":
            self.stage = "trigger"
            raise reveal._Fail("listing_changed")
        return real(self, f)

    monkeypatch.setattr(reveal._Attempt, "reveal", patched)
    outcome, _, _ = run(Scenario(refuse_reveal=True))
    for attempt in outcome.diagnostics.attempts:
        assert (attempt.reason, attempt.stage) == ("value_not_found", "value_wait")


def test_try_again_later_attempt_records_captcha_state_not_done():
    outcome, _, _ = run(Scenario(try_again_later=True))
    for attempt in outcome.diagnostics.attempts:
        assert (attempt.reason, attempt.stage) == ("try_again_later", "captcha_state")


def test_widget_removed_on_a_checkbox_pass_still_reveals():
    outcome, logs, reopened = run(Scenario(captcha="checkbox_only", vanish_on_pass=True))
    (attempt,) = outcome.diagnostics.attempts
    assert (attempt.outcome, attempt.reason, attempt.stage) == ("revealed", None, "done")
    assert attempt.pass_evidence == "value_only" and attempt.checkbox_only is True
    assert attempt.prefix_check == {"reg_number": "passed", "vin": "passed"}
    assert outcome.registration.reg_number_status == "revealed"
    assert outcome.registration.vin_status == "revealed"
    assert not reopened


def test_widget_removed_without_a_value_is_browser_error(monkeypatch):
    monkeypatch.setattr("auto24_service.captcha.reveal._GONE_VALUE_WAIT_S", 1.0)
    outcome, logs, reopened = run(Scenario(remove_widget=True), attempt_seconds=30)
    for attempt in outcome.diagnostics.attempts:
        assert (attempt.outcome, attempt.reason, attempt.stage) == ("failed", "browser_error", "captcha_state")
        assert attempt.pass_evidence is None
    assert len(outcome.diagnostics.attempts) == 2
    assert outcome.registration.reg_number_status == "unavailable"


def test_normal_pass_has_no_pass_evidence_flag():
    outcome, _, _ = run(Scenario(captcha="checkbox_only"))
    (attempt,) = outcome.diagnostics.attempts
    assert attempt.outcome == "revealed" and attempt.checkbox_only is True and attempt.pass_evidence is None
