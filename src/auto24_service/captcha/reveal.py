"""Reveal the registration number and VIN on an Auto24 listing.

Clicks "näita reg. nr." and then "näita VIN", solves the reCAPTCHA when Auto24 asks
for one, checks each value against the page preview and Auto24's own JSON reply, and
retries once in a fresh session. Revealed values never go into the diagnostics.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from auto24_service.browser import CaptureError, ListingSession
from auto24_service.captcha.recaptcha import solve_recaptcha
from auto24_service.captcha.solver import SolverLike
from auto24_service.contracts import (
    AttemptRecord,
    AttemptStage,
    Registration,
    RevealDiagnostics,
    RevealFailureReason,
    RoundRecord,
)

FieldName = Literal["reg_number", "vin"]
_ROUNDS_PER_ATTEMPT = 3
_POLL_MS = 200
# After the widget leaves the page with no pass seen, how long to look for the value.
_GONE_VALUE_WAIT_S = 10.0
# Failures tied to one value; the attempt goes on to the next field.
_FIELD_ONLY = ("value_not_found", "value_rejected", "prefix_mismatch", "listing_changed")


@dataclass(frozen=True)
class _Field:
    name: FieldName
    row: str
    action: str
    value: str
    fallback_value: str | None


_FIELDS = (
    _Field("reg_number", "tr.field-reg_nr", "uv_regnr", "tr.field-reg_nr .value", None),
    _Field(
        "vin",
        "tr.field-tehasetahis",
        "uv_vin",
        "tr.field-tehasetahis .value .-response",
        "tr.field-tehasetahis .value",
    ),
)


@dataclass
class RevealOutcome:
    registration: Registration
    diagnostics: RevealDiagnostics


# --- value checks -------------------------------------------------------------

_REG_CHARS = "A-Za-z0-9ÕÄÖÜŠŽõäöüšž"
_REG_RE = re.compile(rf"^[{_REG_CHARS}](?:[{_REG_CHARS}]| |-)*$")
_VIN_STANDARD_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
_VIN_ANY_RE = re.compile(r"^[A-Za-z0-9]{1,17}$")


def check_reg_number(value: str) -> bool:
    text = value.strip()
    return 0 < len(text) <= 20 and bool(_REG_RE.match(text))


def vin_format(value: str) -> Literal["standard", "nonstandard"] | None:
    text = value.strip()
    if _VIN_STANDARD_RE.match(text.upper()):
        return "standard"
    if _VIN_ANY_RE.match(text):
        return "nonstandard"
    return None


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text).casefold()


def prefix_matches(prefix: str | None, value: str) -> Literal["passed", "failed", "skipped"]:
    if prefix is None:
        return "skipped"
    stem = _norm(prefix).rstrip(".…")
    if not stem:
        return "skipped"
    return "passed" if _norm(value).startswith(stem) else "failed"


def _value_ok(name: FieldName, value: str) -> bool:
    return check_reg_number(value) if name == "reg_number" else vin_format(value) is not None


# --- page reading ---------------------------------------------------------------


@dataclass
class _Row:
    present: bool
    trigger: bool
    prefix: str | None
    text: str


def _read_row(page, f: _Field) -> _Row:
    data = page.evaluate(
        """([row, action, value, fallback]) => {
            const r = document.querySelector(row);
            if (!r) return null;
            const trig = r.querySelector('.service-trigger[data-action="' + action + '"]');
            const prev = r.querySelector('.preview');
            // Links such as "Kontrolli ajalugu" are not the value. A revealed value
            // inside an <a> would therefore read as empty.
            const linkless = (el) => {
                const c = el.cloneNode(true);
                c.querySelectorAll('a').forEach((a) => a.remove());
                return c;
            };
            let v = document.querySelector(value);
            if (!v && fallback) v = document.querySelector(fallback);
            return {trigger: !!trig, prefix: prev ? prev.textContent : null,
                    text: v ? linkless(v).textContent.trim() : ''};
        }""",
        [f.row, f.action, f.value, f.fallback_value],
    )
    if data is None:
        return _Row(False, False, None, "")
    return _Row(True, data["trigger"], data["prefix"], data["text"])


def _has_value(row: _Row) -> bool:
    return row.present and not row.trigger and bool(row.text) and not row.text.endswith(("...", "…"))


def _captcha_shown(page, f: _Field) -> bool:
    gc2 = f.row.replace("tr.", "tr.sub-field.") + "-gc2"
    return bool(page.evaluate("s => !!document.querySelector(s + ' .germ')", gc2))


# --- one attempt ----------------------------------------------------------------


class _Fail(Exception):
    def __init__(self, reason: RevealFailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _Attempt:
    session: ListingSession
    solver: SolverLike
    deadline: float
    clock: Callable[[], float]
    save_image: Callable[[str, bytes], None] | None
    debug: Callable | None = None  # hook(event, page, info), attempt already bound
    rounds: list[RoundRecord] = field(default_factory=list)
    captcha_results: list[bool] = field(default_factory=list)  # checkbox_only per pass
    prefix_check: dict = field(default_factory=dict)
    replies: list = field(default_factory=list)
    stage: AttemptStage = "trigger"
    error_type: str | None = None  # exception class name, never the message
    pass_evidence: Literal["value_only"] | None = None

    @property
    def page(self):
        return self.session.page

    def on_response(self, response) -> None:
        if urlsplit(response.url).path == "/services/data_json.php":
            self.replies.append(response)

    def wait(self) -> None:
        if self.clock() + _POLL_MS / 1000 > self.deadline:
            raise _Fail("timeout")
        self.page.wait_for_timeout(_POLL_MS)

    def json_replies(self, f: _Field) -> list[dict]:
        found = []
        for response in list(self.replies):
            request = response.request
            q = parse_qs(urlsplit(request.url).query).get("q", [""])[0]
            if not q and request.post_data:
                q = parse_qs(request.post_data).get("q", [""])[0]
            if q.removesuffix("_sec") != f.action:
                continue
            try:
                body = json.loads(response.text())
            except Exception:
                continue
            found.append(body.get("q") or {})
        return found

    def refused(self, f: _Field) -> bool:
        return any(q.get("status") != 1 for q in self.json_replies(f))

    def json_value(self, f: _Field) -> str | None:
        values = [
            (q.get("response") or {}).get("value")
            for q in self.json_replies(f)
            if q.get("status") == 1 and not (q.get("response") or {}).get("replace")
        ]
        values = [v for v in values if isinstance(v, str)]
        return values[-1] if values else None

    def solve(self, f: _Field) -> None:
        rounds_left = _ROUNDS_PER_ATTEMPT - len(self.rounds)
        if rounds_left <= 0:
            raise _Fail("captcha_rounds_exhausted")
        result = solve_recaptcha(
            self.page,
            self.solver,
            deadline=self.deadline,
            rounds_left=rounds_left,
            clock=self.clock,
            save_image=self.save_image,
            debug=self.debug,
        )
        self.rounds.extend(result.rounds)
        found = self.value_after_widget_gone(f) if not result.passed and result.widget_gone else None
        if found == "value":
            # Google passed and Auto24 removed the widget before the tick was seen.
            # reveal() still checks the value and Auto24's JSON value.
            self.pass_evidence = "value_only"
            self.stage = "value_wait"
            self.captcha_results.append(result.checkbox_only)
            if self.rounds and self.rounds[-1].stage == "verify_wait":
                # The round's verify was the pass: the value only comes after one.
                self.rounds[-1] = self.rounds[-1].model_copy(update={"result": "solved", "stage": "done"})
            self.call_debug("value_after_widget_gone")
            return
        if found == "timeout":
            if result.stage is not None:
                self.stage = result.stage
            raise _Fail("timeout")
        if not result.passed:
            self.error_type = result.error_type
            if result.stage is not None:
                self.stage = result.stage
            raise _Fail(result.reason or "browser_error")
        self.stage = "value_wait"
        self.captcha_results.append(result.checkbox_only)

    def value_after_widget_gone(self, f: _Field) -> Literal["value", "missing", "timeout"]:
        """Wait briefly for the field's value and Auto24's JSON value to appear.

        "timeout" when the attempt deadline cut the wait short.
        """
        wanted = self.clock() + _GONE_VALUE_WAIT_S
        limit = min(self.deadline, wanted)
        while True:
            if _has_value(_read_row(self.page, f)) and self.json_value(f) is not None:
                return "value"
            if self.refused(f):
                return "missing"
            if self.clock() + _POLL_MS / 1000 > limit:
                return "timeout" if self.deadline < wanted else "missing"
            self.page.wait_for_timeout(_POLL_MS)

    def call_debug(self, event: str, **info) -> None:
        if self.debug is None:
            return
        info.setdefault("stage", self.stage)
        try:
            self.debug(event, self.page, info)
        except Exception:
            pass

    def reveal(self, f: _Field) -> str:
        self.stage = "trigger"
        row = _read_row(self.page, f)
        if not row.present or not row.trigger:
            raise _Fail("listing_changed")
        prefix = row.prefix
        left_ms = (self.deadline - self.clock()) * 1000
        if left_ms <= 0:
            raise _Fail("timeout")
        self.page.click(f'{f.row} .service-trigger[data-action="{f.action}"]', timeout=left_ms)
        self.call_debug("trigger_clicked")
        self.stage = "value_wait"
        solved = 0
        while True:
            row = _read_row(self.page, f)
            if _has_value(row):
                break
            if self.refused(f):
                raise _Fail("value_not_found")
            if solved == 0 and _captcha_shown(self.page, f):
                self.stage = "captcha_checkbox"
                self.solve(f)
                solved += 1
                continue
            self.wait()
        value = row.text
        expected = self.json_value(f)
        if expected is None or _norm(expected) != _norm(value) or not _value_ok(f.name, value):
            raise _Fail("value_rejected")
        check = prefix_matches(prefix, value)
        self.prefix_check[f.name] = check
        if check == "failed":
            raise _Fail("prefix_mismatch")
        return value.strip()


# --- public entry ---------------------------------------------------------------


def _initial_state(page) -> dict[FieldName, tuple[str, str | None]]:
    """Per field: (listed_in_full | hidden | not_listed | rejected, value)."""
    state: dict[FieldName, tuple[str, str | None]] = {}
    for f in _FIELDS:
        row = _read_row(page, f)
        if not row.present:
            state[f.name] = ("not_listed", None)
        elif row.trigger:
            state[f.name] = ("hidden", None)
        elif _has_value(row) and _value_ok(f.name, row.text):
            state[f.name] = ("listed_in_full", row.text.strip())
        elif not row.text:
            # Nothing but links (or nothing at all): no identifier is listed.
            state[f.name] = ("not_listed", None)
        else:
            # A value is shown but fails the check: unreadable, not retried.
            # Reported as unavailable and named in diagnostics.initial_rejected.
            state[f.name] = ("rejected", None)
    return state


def _run_attempt(
    number: Literal[1, 2],
    session: ListingSession | None,
    pending: list[_Field],
    revealed: dict[FieldName, str],
    solver: SolverLike,
    attempt_seconds: float,
    clock: Callable[[], float],
    save_image,
    forced_reason: RevealFailureReason | None = None,
    debug=None,
    began: tuple[datetime, float] | None = None,
    error_type: str | None = None,
    stage: AttemptStage | None = None,
) -> AttemptRecord:
    """Run one attempt; `began` is (started_at, clock start) when the budget started earlier."""
    started_at, start = began or (datetime.now(timezone.utc), clock())
    if forced_reason is not None or session is None:
        return AttemptRecord(
            attempt=number,
            started_at=started_at,
            duration_ms=max(0, int((clock() - start) * 1000)),
            outcome="failed",
            reason=forced_reason or "browser_error",
            error_type=error_type,
            stage=stage,
        )
    blocked_from = len(session.blocked)
    bound = None
    if debug is not None:
        def bound(event, page, info, _n=number):
            debug(event, page, {**info, "attempt": _n})
    attempt = _Attempt(session, solver, start + attempt_seconds, clock, save_image, bound)
    reason: RevealFailureReason | None = None
    # Stage and error type recorded with the failure that became `reason`, so a
    # later field cannot overwrite them.
    reason_stage: AttemptStage | None = None
    reason_error: str | None = None
    session.page.on("response", attempt.on_response)
    try:
        for f in pending:
            try:
                revealed[f.name] = attempt.reveal(f)
            except _Fail as fail:
                if reason is None:
                    reason = fail.reason
                    reason_stage, reason_error = attempt.stage, attempt.error_type
                if fail.reason not in _FIELD_ONLY:
                    break
    except Exception as exc:
        reason = "timeout" if clock() >= attempt.deadline - 0.05 else "browser_error"
        reason_stage, reason_error = attempt.stage, type(exc).__name__
    finally:
        try:
            session.page.remove_listener("response", attempt.on_response)
        except Exception:
            pass
    attempt.call_debug("attempt_end", reason=reason)
    if reason is not None:
        outcome = "failed"
    elif attempt.captcha_results:
        outcome = "revealed"
    else:
        outcome = "no_captcha_needed"
    return AttemptRecord(
        attempt=number,
        started_at=started_at,
        duration_ms=max(0, int((clock() - start) * 1000)),
        outcome=outcome,
        reason=reason,
        checkbox_only=all(attempt.captcha_results) if attempt.captcha_results else None,
        error_type=reason_error if reason in ("timeout", "browser_error") else None,
        stage="done" if reason is None else reason_stage,
        pass_evidence=attempt.pass_evidence,
        rounds=attempt.rounds,
        prefix_check=attempt.prefix_check,
        blocked_requests=list(session.blocked[blocked_from:]),
    )


def reveal_registration(
    first: ListingSession,
    reopen: Callable[[], AbstractContextManager[ListingSession]],
    solver: SolverLike,
    *,
    attempt_seconds: float = 90.0,
    force_failure: bool = False,
    save_image: Callable[[str, bytes], None] | None = None,
    clock: Callable[[], float] = time.monotonic,
    deadline: float | None = None,
    debug: Callable | None = None,
) -> RevealOutcome:
    """Reveal both values; never raises for a reveal failure.

    `deadline` is a `clock()` value the whole reveal must finish by (the worker
    derives it from the job lease). Attempt 1 is shortened to fit it, and attempt 2
    is skipped with a `timeout` record when too little time is left.
    """
    attempts: list[AttemptRecord] = []
    revealed: dict[FieldName, str] = {}
    try:
        state = _initial_state(first.page)
    except Exception:
        state = {f.name: ("unavailable", None) for f in _FIELDS}
    try:
        pending = [f for f in _FIELDS if state[f.name][0] == "hidden"]
        if pending and force_failure:
            for number in (1, 2):
                attempts.append(
                    _run_attempt(number, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                                 forced_reason="widget_not_found")
                )
        elif pending:
            first_seconds = _fit(attempt_seconds, deadline, clock, 0.0)
            if deadline is not None and first_seconds < _MIN_ATTEMPT_SECONDS:
                attempts.append(
                    _run_attempt(1, None, pending, revealed, solver, 0.0, clock, save_image,
                                 forced_reason="timeout")
                )
            else:
                attempts.append(
                    _run_attempt(1, first, pending, revealed, solver, first_seconds, clock, save_image,
                                 debug=debug)
                )
            pending = [f for f in pending if f.name not in revealed]
            if pending:
                second_seconds = _fit(attempt_seconds, deadline, clock, _JOIN_MARGIN_SECONDS)
                if deadline is not None and second_seconds < _MIN_SECOND_ATTEMPT_SECONDS:
                    attempts.append(
                        _run_attempt(2, None, pending, revealed, solver, 0.0, clock, save_image,
                                     forced_reason="timeout")
                    )
                else:
                    attempts.append(
                        _second_attempt(reopen, pending, revealed, solver, second_seconds, clock, save_image,
                                        debug=debug)
                    )
    except Exception:
        pass
    rejected = [f.name for f in _FIELDS if state[f.name][0] == "rejected"]
    return RevealOutcome(
        _registration(state, revealed),
        RevealDiagnostics(attempts=attempts, initial_rejected=rejected),
    )


_JOIN_MARGIN_SECONDS = 5.0
# Below these budgets an attempt cannot finish a CAPTCHA, so it is recorded as a
# timeout instead of started. Attempt 2 also has to launch a browser and navigate.
_MIN_ATTEMPT_SECONDS = 10.0
_MIN_SECOND_ATTEMPT_SECONDS = 30.0


def _fit(attempt_seconds: float, deadline: float | None, clock, margin: float) -> float:
    if deadline is None:
        return attempt_seconds
    return min(attempt_seconds, deadline - clock() - margin)


def _second_attempt(reopen, pending, revealed, solver, attempt_seconds, clock, save_image,
                    debug=None) -> AttemptRecord:
    # Sync Playwright cannot start a second browser on a thread that already drives
    # one, and `first` stays open, so the fresh session runs on its own thread.
    # The attempt budget covers reopen() too: browser launch and navigation count.
    began = (datetime.now(timezone.utc), clock())
    box: dict = {}
    found: dict[FieldName, str] = {}

    def work() -> None:
        try:
            box["record"] = _reopened_attempt(
                reopen, pending, found, solver, attempt_seconds, clock, save_image, began, debug
            )
        except BaseException as exc:  # pragma: no cover - _reopened_attempt catches errors
            box["error"] = exc

    thread = threading.Thread(target=work, name="reveal-attempt-2", daemon=True)
    thread.start()
    thread.join(attempt_seconds + _JOIN_MARGIN_SECONDS)
    if thread.is_alive():
        # The thread is left running as a daemon. If it hangs inside reopen() or the
        # browser, it may leak that browser until the process exits; its late
        # results are dropped because `found` is never merged.
        return _run_attempt(2, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                            forced_reason="timeout", began=began)
    if "record" in box:
        revealed.update(found)
        return box["record"]
    error = box.get("error")
    return _run_attempt(2, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                        forced_reason="browser_error", began=began,
                        error_type=type(error).__name__ if error is not None else None)


def _reopened_attempt(reopen, pending, revealed, solver, attempt_seconds, clock, save_image, began,
                      debug=None) -> AttemptRecord:
    record: AttemptRecord | None = None
    stage: AttemptStage = "reopen"
    try:
        with reopen() as session:
            if clock() >= began[1] + attempt_seconds:
                record = _run_attempt(2, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                                      forced_reason="timeout", began=began, stage="reopen")
            else:
                stage = "trigger"
                record = _run_attempt(2, session, pending, revealed, solver, attempt_seconds, clock, save_image,
                                      began=began, debug=debug)
        # A failure while closing the browser after the attempt is not recorded:
        # the kept record matches the values the attempt revealed.
        return record
    except CaptureError:
        if record is not None:
            return record  # closing the browser failed after the attempt finished
        return _run_attempt(2, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                            forced_reason="listing_changed", began=began, stage=stage)
    except Exception as exc:
        if record is not None:
            # Closing the browser failed after the attempt finished: keep its record,
            # which matches the values it revealed.
            return record
        return _run_attempt(2, None, pending, revealed, solver, attempt_seconds, clock, save_image,
                            forced_reason="browser_error", began=began, error_type=type(exc).__name__, stage=stage)


def _registration(state, revealed: dict[FieldName, str]) -> Registration:
    out: dict = {}
    for f in _FIELDS:
        status, value = state[f.name]
        if f.name in revealed:
            status, value = "revealed", revealed[f.name]
        elif status in ("hidden", "rejected"):
            status = "unavailable"
        out[f.name] = value
        out[f"{f.name}_status"] = status
    out["vin_format"] = vin_format(out["vin"]) if out["vin"] is not None else None
    return Registration(**out)
