"""Watch the CaptchaRaptor extension solve a reCAPTCHA on Chromium (Plan A).

Python never touches the widget. It reads the challenge frame's reload and
userverify replies to count rounds, watches the checkbox and the grid for
progress, and ends the wait on a pass, the field's value appearing, a vanished
widget, a refusal or a stall.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Final
from urllib.parse import parse_qs

from ..contracts import AttemptStage, RevealFailureReason, RoundRecord
from .labels import resolve_label
from .recaptcha import _WATCHED, CaptchaResult, _challenge_parts, _frame, _google_json


class _Extension:
    def __repr__(self) -> str:
        return "EXTENSION"


# Solver value that makes reveal.py wait for the extension instead of driving the widget.
EXTENSION: Final = _Extension()

_POLL_MS = 200
_CHECKED = "() => document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked')"
_TILE_SOURCES = "() => Array.from(document.querySelectorAll('td.rc-imageselect-tile img'), i => i.src)"


class _Failed(Exception):
    def __init__(self, reason: RevealFailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _Round:
    challenge: str | None
    started: float
    grid: str = "3x3"
    label_id: str | None = None
    label: str | None = None
    label_source: str = "none"
    result: str | None = None  # set when the round ends
    stage: str | None = None
    ended: float | None = None
    incomplete: bool = False

    def end(self, result: str, stage: str | None, now: float) -> None:
        self.result, self.stage, self.ended = result, stage, now

    def record(self, now: float) -> RoundRecord:
        return RoundRecord(
            solver="extension", grid=self.grid, instruction=None, label_id=self.label_id,
            label=self.label, label_source=self.label_source, tiles=[], tiles_clicked=[],
            duration_ms=max(1, int(((self.ended or now) - self.started) * 1000)),
            result=self.result or "timeout", stage=self.stage, incomplete=self.incomplete,
        )


def _challenge_id(data) -> str | None:
    """The id of the challenge a reload reply (or a nested "rresp" entry) carries."""
    if isinstance(data, list) and len(data) > 1 and data[0] == "rresp":
        return data[1] if isinstance(data[1], str) and data[1] else None
    return None


class _Watch:
    def __init__(self, page, deadline, rounds_left, clock, stall_s, debug, value_shown) -> None:
        self.page = page
        self.value_shown = value_shown
        self.deadline = deadline
        self.rounds_left = rounds_left
        self.clock = clock
        self.stall_s = stall_s
        self.debug_hook = debug
        self.replies: list = []  # (kind, response), appended by the context listener
        self.read = 0
        self.rounds: list[_Round] = []
        self.incomplete_pending = False
        self.anchor = None
        self.tile_sources: set[str] = set()
        self.challenge_seen = False
        self.stage: AttemptStage = "captcha_checkbox"

    def on_response(self, response) -> None:
        match = _WATCHED.search(response.url)
        if match:
            self.replies.append((match.group(1), response))

    # --- rounds ---------------------------------------------------------------

    def open_round(self) -> _Round | None:
        return self.rounds[-1] if self.rounds and self.rounds[-1].result is None else None

    def start_round(self, challenge: str, data) -> bool:
        """A new round for an unseen challenge id. False for an id already seen."""
        if any(r.challenge == challenge for r in self.rounds):
            return False
        now = self.clock()
        current = self.open_round()
        if current is not None:
            current.end("incorrect", "done", now)  # Google replaced the challenge
        elif self.rounds and self.rounds[-1].result == "solved":
            self.rounds[-1].result = "incorrect"  # a token, then a new challenge anyway
        new = _Round(challenge, now, incomplete=self.incomplete_pending)
        self.incomplete_pending = False
        parts = _challenge_parts(data)
        if parts is not None:
            new.grid = "4x4" if parts.size == 4 else "3x3_dynamic" if parts.kind == "dynamic" else "3x3"
            new.label_id = parts.label_id
            new.label, new.label_source = resolve_label(parts.label_id, parts.name, None)
        self.rounds.append(new)
        self.challenge_seen = True
        self.stage = "captcha_round"
        self.debug("round_start", round=len(self.rounds))
        return True

    def end_round(self, challenge: str | None, solved: bool) -> None:
        result = "solved" if solved else "incorrect"
        current = self.open_round()
        if challenge is not None and any(r.challenge == challenge and r.result for r in self.rounds):
            return  # a repeated reply for a round that already ended
        if current is not None and challenge in (None, current.challenge):
            current.end(result, "done", self.clock())
        elif challenge is not None:
            # The reload reply was missed: the round starts and ends here.
            self.start_round(challenge, None)
            self.rounds[-1].end(result, "done", self.clock())

    def mark_incomplete(self) -> None:
        target = self.open_round() or (self.rounds[-1] if self.rounds else None)
        if target is None:
            self.incomplete_pending = True
        else:
            target.incomplete = True

    def failed_rounds(self) -> int:
        return sum(1 for r in self.rounds if r.result is not None and r.result != "solved")

    def read_replies(self) -> bool:
        """Account for new reload and userverify replies; True when a new round began."""
        progress = False
        # Replies after the last allowed round ends are left unread.
        while self.read < len(self.replies) and self.failed_rounds() < self.rounds_left:
            kind, response = self.replies[self.read]
            self.read += 1
            if kind not in ("reload", "userverify"):
                continue  # images and refills: progress shows in the grid instead
            try:
                data = _google_json(response.text())
            except Exception:
                self.mark_incomplete()
                continue
            if kind == "reload":
                if not (isinstance(data, list) and data and data[0] == "rresp"):
                    self.mark_incomplete()
                    continue
                challenge = _challenge_id(data)
                if challenge is not None:
                    progress = self.start_round(challenge, data) or progress
                continue
            if not (isinstance(data, list) and data and data[0] == "uvresp"):
                self.mark_incomplete()
                continue
            try:
                answered = parse_qs(response.request.post_data or "").get("c", [None])[0]
            except Exception:
                answered = None
            token = len(data) > 1 and isinstance(data[1], str) and bool(data[1])
            refused = len(data) > 2 and data[2] == 0
            self.end_round(answered, token and not refused)
            # A refused verify can carry the next challenge.
            for item in data:
                challenge = _challenge_id(item)
                if challenge is not None:
                    progress = self.start_round(challenge, item) or progress
        return progress

    # --- page -------------------------------------------------------------------

    def checked(self) -> bool | None:
        """True when the widget's checkbox ticked; None when the widget left the page."""
        if self.anchor is None:
            self.anchor = _frame(self.page, "/anchor")
            if self.anchor is None:
                return False
            if self.stage == "captcha_checkbox":
                self.stage = "captcha_state"
        if self.anchor.is_detached():
            return None
        try:
            return self.anchor.evaluate(_CHECKED) == "true"
        except Exception:
            return None if self.anchor.is_detached() else False

    def try_again_later(self) -> bool:
        frame = _frame(self.page, "/bframe")
        if frame is None:
            return False
        try:
            items = frame.locator(".rc-doscaptcha-header")
            return any(items.nth(i).is_visible() for i in range(items.count()))
        except Exception:
            return False

    def new_tiles(self) -> bool:
        frame = _frame(self.page, "/bframe")
        if frame is None:
            return False
        try:
            sources = set(frame.evaluate(_TILE_SOURCES))
        except Exception:
            return False
        fresh = sources - self.tile_sources
        self.tile_sources |= sources
        if sources:
            self.challenge_seen = True
        return bool(fresh)

    def debug(self, event: str, **info) -> None:
        if self.debug_hook is None:
            return
        info.setdefault("stage", self.stage)
        info["left_s"] = self.deadline - self.clock()
        try:
            self.debug_hook(event, self.page, info)
        except Exception:
            pass

    # --- flow -------------------------------------------------------------------

    def result(self, passed: bool, reason: RevealFailureReason | None, **extra) -> CaptchaResult:
        now = self.clock()
        return CaptchaResult(
            passed, reason, not self.challenge_seen, [r.record(now) for r in self.rounds],
            stage="done" if passed else self.stage, **extra,
        )

    def end_open(self, result: str, stage: str | None) -> None:
        current = self.open_round()
        if current is not None:
            current.end(result, stage, self.clock())

    def run(self) -> CaptchaResult:
        progress_at = self.clock()
        while True:
            if self.page.is_closed():
                raise _Failed("browser_error")
            progress = self.read_replies()
            if self.failed_rounds() >= self.rounds_left:
                raise _Failed("captcha_rounds_exhausted")
            if self.value_shown is not None and self.value_shown():
                # Auto24 accepted a token: the caller still checks the value.
                self.end_open("solved", "done")
                return self.result(True, None)
            checked = self.checked()
            if checked:
                self.end_open("solved", "done")
                return self.result(True, None)
            if checked is None:
                # The caller checks the page for the value; a round still open was
                # waiting for Google's verdict when the widget went.
                self.end_open("incorrect", "verify_wait")
                return self.result(False, "browser_error", widget_gone=True)
            if self.try_again_later():
                self.end_open("try_again_later", "done")
                raise _Failed("try_again_later")
            if self.new_tiles() or progress:
                progress_at = self.clock()
            if self.clock() - progress_at >= self.stall_s:
                if self.anchor is None:
                    raise _Failed("widget_not_found")
                self.stage = "stall"
                raise _Failed("timeout")
            if self.clock() + _POLL_MS / 1000 > self.deadline:
                raise _Failed("timeout")
            self.page.wait_for_timeout(_POLL_MS)


def watch_extension(
    page,
    *,
    deadline: float,
    rounds_left: int,
    clock: Callable[[], float] = time.monotonic,
    stall_s: float = 20.0,
    debug: Callable | None = None,
    value_shown: Callable[[], bool] | None = None,
) -> CaptchaResult:
    """Wait while the extension solves the widget on the page.

    Progress is a new round, new tile images in the challenge frame, the checkbox
    ticking, the field's value appearing (`value_shown`, which ends the wait as a
    pass) or the widget leaving the page. Any other traffic, repeated replies for
    a round included, does not reset the `stall_s` timer.
    """
    watch = _Watch(page, deadline, rounds_left, clock, stall_s, debug, value_shown)
    context = page.context
    context.on("response", watch.on_response)
    try:
        result = watch.run()
    except _Failed as failed:
        watch.end_open("timeout" if failed.reason == "timeout" else "incorrect", None)
        result = watch.result(False, failed.reason)
    except Exception as exc:
        reason: RevealFailureReason = "timeout" if clock() >= deadline - 0.05 else "browser_error"
        watch.end_open("timeout" if reason == "timeout" else "incorrect", None)
        result = watch.result(False, reason, error_type=type(exc).__name__)
    finally:
        try:
            context.remove_listener("response", watch.on_response)
        except Exception:
            pass
    watch.debug("captcha_end", reason="passed" if result.passed else result.reason,
                widget_gone=result.widget_gone)
    return result
