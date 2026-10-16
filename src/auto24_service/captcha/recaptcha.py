"""Drive a reCAPTCHA v2 widget: click the checkbox, solve image rounds, verify.

Challenge data (label id, grid type, images) comes from Google's network responses.
Clicks go through page.mouse at a random point inside each element.
"""

from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Literal

from playwright.sync_api import Frame, Page, Response

from ..contracts import AttemptStage, RevealFailureReason, RoundRecord, RoundStage, TileRecord
from .labels import resolve_label
from .solver import SolverLike

_WATCHED = re.compile(r"/recaptcha/(?:api2|enterprise)/(reload|payload|userverify|replaceimage)")
_POLL_MS = 200
_IMAGE_WAIT_S = 6.0
_CHALLENGE_KINDS = ("imageselect", "dynamic", "multicaptcha", "tileselect")
_OFFSCREEN_PX = 1000
_SELECT_MORE = ".rc-imageselect-error-select-more, .rc-imageselect-error-dynamic-more"

Grid = Literal["3x3", "3x3_dynamic", "4x4"]


@dataclass
class CaptchaResult:
    passed: bool
    reason: RevealFailureReason | None
    checkbox_only: bool
    rounds: list[RoundRecord] = field(default_factory=list)
    error_type: str | None = None  # exception class name, never the message
    stage: AttemptStage | None = None  # where the driver was when it ended (ATTEMPT_STAGES)
    # The widget left the page before any pass evidence was seen. Not a pass: the
    # caller has to check the page for the value. `checkbox_only` then says whether
    # a challenge frame was ever shown.
    widget_gone: bool = False


class _Deadline(Exception):
    pass


class _End(Exception):
    def __init__(self, reason: RevealFailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


class _WidgetGone(_End):
    """The clicked widget left the page without a tick or a closed challenge."""

    def __init__(self) -> None:
        super().__init__("browser_error")


def _google_json(text: str):
    if text.startswith(")]}'"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    return json.loads(text)


_LABEL_ID = re.compile(r"^/m/[0-9a-z_]+$")


def _label_meta(value, depth: int = 0) -> list | None:
    """First list, depth-first, whose first element is a /m/ label id."""
    if not isinstance(value, list) or depth > 4:
        return None
    if value and isinstance(value[0], str) and _LABEL_ID.match(value[0]):
        return value
    for item in value:
        found = _label_meta(item, depth + 1)
        if found is not None:
            return found
    return None


def _count_label_lists(value, depth: int = 0) -> int:
    """How many lists, at any depth up to 4, start with a /m/ label id."""
    if not isinstance(value, list) or depth > 4:
        return 0
    own = 1 if value and isinstance(value[0], str) and _LABEL_ID.match(value[0]) else 0
    return own + sum(_count_label_lists(item, depth + 1) for item in value)


def _known_layout(meta: list) -> bool:
    """[label_id or None, _, n, n, n, _, name]: the layout seen in real 3x3 data."""
    return (
        len(meta) >= 5
        and (meta[0] is None or (isinstance(meta[0], str) and bool(_LABEL_ID.match(meta[0]))))
        and all(isinstance(x, int) and not isinstance(x, bool) for x in meta[2:5])
        and meta[2] == meta[3] == meta[4]
        and meta[2] in (3, 4)
    )


@dataclass(frozen=True)
class Challenge:
    """What a reload or userverify body says about the next challenge."""

    label_id: str | None
    name: str | None
    size: int  # 3 or 4 when the data says so, else 0 (then the DOM decides)
    kind: str | None
    shape: object  # structure of the pmeta entry, for debug records
    id_lists: int = 0  # lists in the entry that start with a /m/ id (debug records)


def pmeta_shape(value, depth: int = 0):
    """Types and lengths only. Strings show as "str" except /m/ label ids, which
    are Google's public category ids."""
    if isinstance(value, list):
        if depth >= 4:
            return f"list[{len(value)}]"
        return [pmeta_shape(x, depth + 1) for x in value[:12]] + (["..."] if len(value) > 12 else [])
    if value is None:
        return None
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return value if isinstance(value, int) and 0 <= value <= 16 else type(value).__name__
    if isinstance(value, str):
        return value if _LABEL_ID.match(value) else "str"
    return type(value).__name__


def _challenge_parts(data) -> Challenge | None:
    """The challenge a reload or userverify body carries, or None without a pmeta entry.

    Real 3x3 data is ["pmeta", [label_id, null, 3, 3, 3, null, name]]. Other
    challenge types may put the label list elsewhere in the entry, so the label id
    is found by its /m/ form, and the size is trusted only in the known layout.
    """
    if not isinstance(data, list):
        return None
    entry = next((x for x in data if isinstance(x, list) and x and x[0] == "pmeta"), None)
    if entry is None:
        return None
    kind = next((x for x in data if isinstance(x, str) and x in _CHALLENGE_KINDS), None)
    meta = _label_meta(entry[1:])
    if meta is None:
        meta = next((x for x in entry[1:] if isinstance(x, list)), [])
    label_id = meta[0] if meta and isinstance(meta[0], str) and _LABEL_ID.match(meta[0]) else None
    known = _known_layout(meta)
    name = meta[6] if known and len(meta) > 6 and isinstance(meta[6], str) else None
    size = meta[2] if known else 0
    return Challenge(label_id, name, size, kind, pmeta_shape(entry), _count_label_lists(entry[1:]))


def _frame(page: Page, part: str) -> Frame | None:
    # Newest match: a later widget's frames come after the frames of an earlier one,
    # whose hidden challenge frame stays in the page.
    found = None
    for frame in page.frames:
        if "/recaptcha/" in frame.url and part in frame.url and not frame.is_detached():
            found = frame
    return found


class _Driver:
    def __init__(self, page, solver, deadline, rounds_left, clock, rng, save_image, debug=None) -> None:
        self.page = page
        self.debug_hook = debug
        self.last_click: tuple[float, float] | None = None
        self.solver = solver
        self.deadline = deadline
        self.rounds_left = rounds_left
        self.clock = clock
        self.rng = rng
        self.save_image = save_image
        self.responses: list[tuple[str, str, Response]] = []  # (kind, url, response)
        self.rounds: list[RoundRecord] = []
        self.challenge_seen = False
        self.images_saved = 0
        self.start_url = page.url
        self.anchor_was_checked = False
        self.anchor_frame: Frame | None = None  # set when the checkbox is clicked
        self.tick_id: str | None = None
        self.source_floor = 0  # challenge data before this response index is stale
        self.awaiting_new: str | None = None  # first tile src of a challenge Google is replacing
        self.stage: AttemptStage = "captcha_checkbox"
        self.round_stage: RoundStage | None = None  # stage of the current round
        self.error_type: str | None = None  # class name of the exception that ended the run

    # --- plumbing -------------------------------------------------------------

    def on_response(self, response: Response) -> None:
        match = _WATCHED.search(response.url)
        if match:
            self.responses.append((match.group(1), response.url, response))

    def left_ms(self) -> float:
        left = (self.deadline - self.clock()) * 1000
        if left <= 0:
            raise _Deadline()
        return max(1.0, left)

    def wait(self, ms: float) -> None:
        if self.clock() + ms / 1000 > self.deadline:
            raise _Deadline()
        self.page.wait_for_timeout(ms)

    def click(self, locator) -> None:
        box = locator.bounding_box(timeout=self.left_ms())
        if box is None:
            raise _End("browser_error")
        x = box["x"] + box["width"] * self.rng.uniform(0.25, 0.75)
        y = box["y"] + box["height"] * self.rng.uniform(0.25, 0.75)
        self.last_click = (x, y)
        self.page.mouse.click(x, y)

    def src(self, img) -> str:
        return img.evaluate("e => e.src", timeout=self.left_ms())

    def visible(self, frame: Frame | None, selector: str) -> bool:
        if frame is None or frame.is_detached():
            return False
        items = frame.locator(selector)
        return any(items.nth(i).is_visible() for i in range(items.count()))

    def anchor_checked(self) -> bool | None:
        """True when the clicked checkbox ticked; None when its frame is gone."""
        if self.page.is_closed() or self.page.url != self.start_url:
            raise _End("browser_error")
        anchor = self.anchor()
        if anchor is not None:
            try:
                checked = anchor.locator("#recaptcha-anchor").get_attribute(
                    "aria-checked", timeout=min(500, self.left_ms())
                )
            except _Deadline:
                raise
            except Exception:
                checked = None
            if checked == "true":
                self.anchor_was_checked = True
                return True
            if checked is not None:
                # A tick seen earlier still counts: Google's token outlives the attempt,
                # and reveal() checks the value and Auto24's JSON value either way.
                return self.anchor_was_checked
        if self.anchor_was_checked:
            return True
        if anchor is None and self.page_saw_tick():
            self.anchor_was_checked = True
            return True
        return None if anchor is None else False

    def passed(self) -> bool:
        """Before any verify: a ticked checkbox on the same page is the only pass evidence."""
        checked = self.anchor_checked()
        if checked is None:
            raise _WidgetGone()  # the caller checks the page for the value
        return checked

    def watch_anchor(self, ms: float) -> None:
        """Wait like wait(), but notice the checkbox ticking within ~20 ms.

        The page may remove a ticked widget soon after it posts the token, so a
        plain 200 ms poll can miss the only evidence of a checkbox-only pass.
        """
        if self.clock() + ms / 1000 > self.deadline:
            raise _Deadline()
        anchor = self.anchor()
        if anchor is None or anchor.is_detached():
            self.page.wait_for_timeout(ms)
            return
        try:
            anchor.wait_for_function(
                "() => document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked') === 'true'",
                polling=20,
                timeout=ms,
            )
            self.anchor_was_checked = True
        except Exception:
            pass  # not ticked in this slice, or the frame went away

    def bframe(self) -> Frame | None:
        return _frame(self.page, "/bframe")

    def challenge_visible(self) -> bool:
        """The challenge frame is shown: present, visible, not zero-size and not parked offscreen.

        Google parks a closed frame near -9999 px. The box is viewport-relative, so
        an open frame on a scrolled page can sit a little above 0; only a frame
        more than _OFFSCREEN_PX outside the viewport counts as closed.
        """
        el = self.page.locator('iframe[src*="/recaptcha/"][src*="/bframe"]')
        if el.count() == 0 or not el.last.is_visible():
            return False
        try:
            box = el.last.bounding_box(timeout=min(500, self.left_ms()))
        except _Deadline:
            raise
        except Exception:
            return False  # removed between the two reads
        return (
            box is not None and box["width"] > 0 and box["height"] > 0
            and box["x"] + box["width"] > -_OFFSCREEN_PX and box["y"] + box["height"] > -_OFFSCREEN_PX
        )

    def try_again_later(self) -> bool:
        return self.visible(self.bframe(), ".rc-doscaptcha-header")

    def response_for(self, url: str, after: int = 0) -> Response | None:
        for kind, seen, response in reversed(self.responses[after:]):
            if seen == url and kind in ("payload", "replaceimage"):
                return response
        return None

    def image(self, img, fallback, after: int, name: str) -> bytes:
        src = self.src(img)
        limit = self.clock() + _IMAGE_WAIT_S
        data = None
        while True:
            response = self.response_for(src, after)
            if response is not None:
                try:
                    data = response.body()
                except Exception:
                    data = None
                if data:
                    break
            if self.clock() > limit:
                break
            self.wait(_POLL_MS)
        if not data:
            data = fallback.screenshot(timeout=self.left_ms())
        if self.save_image is not None:
            self.images_saved += 1
            self.save_image(f"{self.images_saved:03d}-{name}", data)
        return data

    def newest_challenge(self) -> tuple[int, Challenge] | None:
        """Newest reload or userverify body with challenge data, at or after source_floor."""
        for index in range(len(self.responses) - 1, self.source_floor - 1, -1):
            kind, _, response = self.responses[index]
            if kind not in ("reload", "userverify"):
                continue
            try:
                parts = _challenge_parts(_google_json(response.text()))
            except Exception:
                continue
            if parts is not None:
                return index, parts
        return None

    def verify_outcome(self, after: int) -> str | None:
        """Read the first userverify response after a verify click.

        "incorrect" when it carries no token. "token" when it does, which is not a
        pass on its own: Google can send one and still show "try again".
        """
        for kind, _, response in self.responses[after:]:
            if kind != "userverify":
                continue
            try:
                data = _google_json(response.text())
            except Exception:
                return None
            if isinstance(data, list) and len(data) > 1 and isinstance(data[1], str) and data[1]:
                return "token"
            return "incorrect"
        return None

    def debug(self, event: str, **info) -> None:
        """Call the debug hook with the frames _frame matched; never fails the run."""
        if self.debug_hook is None:
            return
        try:
            anchor = self.anchor()
            bframe = self.bframe()
            info["matched"] = {
                "anchor": anchor.url if anchor is not None else None,
                "bframe": bframe.url if bframe is not None else None,
            }
        except Exception:
            info["matched"] = {"anchor": None, "bframe": None}
        info.setdefault("stage", self.stage)
        info["click"] = self.last_click
        try:
            self.debug_hook(event, self.page, info)
        except Exception:
            pass

    # --- flow -----------------------------------------------------------------

    def run(self) -> CaptchaResult:
        self.open_checkbox()
        self.stage = "captcha_state"
        state = self.wait_for_state()
        if state == "passed":
            return CaptchaResult(True, None, not self.challenge_seen, self.rounds)
        if state == "try_again_later":
            return CaptchaResult(False, "try_again_later", False, self.rounds)
        self.stage = "captcha_round"
        verifies = 0
        while verifies < self.rounds_left:
            outcome = self.play_round()
            verifies += 1
            if outcome == "solved":
                return CaptchaResult(True, None, False, self.rounds)
            if outcome == "try_again_later":
                return CaptchaResult(False, "try_again_later", False, self.rounds)
        return CaptchaResult(False, "captcha_rounds_exhausted", False, self.rounds)

    def arm_tick_watch(self, anchor: Frame) -> None:
        """Have the checkbox frame tell the page when it ticks.

        Auto24 can remove a ticked widget before the next poll, so a tick seen
        only by polling can be lost. The frame posts a tagged message carrying its
        own URL, and the page keeps the URLs that ticked. Only a tick from the
        widget this driver clicked counts, so an earlier widget's tick on the same
        page is never taken as evidence.
        """
        self.tick_id = anchor.url
        try:
            self.page.evaluate(
                """id => {
                    window.__a24Ticks = window.__a24Ticks || {};
                    delete window.__a24Ticks[id];
                    if (window.__a24TickWatch) return;
                    window.__a24TickWatch = true;
                    window.addEventListener("message", e => {
                        if (e.data && e.data.__a24tick === 1 && typeof e.data.id === "string"
                            && /^https:\\/\\/www\\.google\\.com$/.test(e.origin)) {
                            window.__a24Ticks[e.data.id] = true;
                        }
                    });
                }""",
                self.tick_id,
            )
            anchor.evaluate(
                """() => {
                    const box = document.querySelector("#recaptcha-anchor");
                    const tell = () => {
                        if (box.getAttribute("aria-checked") === "true") {
                            parent.postMessage({__a24tick: 1, id: location.href}, "*");
                        }
                    };
                    new MutationObserver(tell).observe(box, {attributes: true, attributeFilter: ["aria-checked"]});
                }"""
            )
        except Exception:
            pass  # polling still works without the watch

    def page_saw_tick(self) -> bool:
        if self.tick_id is None:
            return False
        try:
            return bool(self.page.evaluate("id => !!(window.__a24Ticks && window.__a24Ticks[id])", self.tick_id))
        except Exception:
            return False

    def anchor(self) -> Frame | None:
        """The checkbox frame of the widget this driver clicked, once it has clicked one."""
        if self.anchor_frame is None:
            return _frame(self.page, "/anchor")
        return None if self.anchor_frame.is_detached() else self.anchor_frame

    def open_checkbox(self) -> None:
        while True:
            anchor = _frame(self.page, "/anchor")
            if anchor is not None:
                box = anchor.locator("#recaptcha-anchor")
                if box.count() > 0 and box.first.is_visible():
                    self.arm_tick_watch(anchor)
                    self.anchor_frame = anchor
                    self.click(box.first)
                    self.debug("checkbox_clicked")
                    return
            if self.clock() + _POLL_MS / 1000 > self.deadline:
                raise _End("widget_not_found")
            self.page.wait_for_timeout(_POLL_MS)

    def wait_for_state(self) -> str:
        """After the checkbox click: a pass, a try-again-later screen or a challenge."""
        next_debug = self.clock() + 10
        while True:
            if self.debug_hook is not None and self.clock() >= next_debug:
                self.debug("captcha_state_wait")
                next_debug = self.clock() + 10
            if self.challenge_visible():
                self.challenge_seen = True
                if self.try_again_later():
                    return "try_again_later"
                frame = self.bframe()
                if frame is not None and frame.locator("td.rc-imageselect-tile").count() > 0:
                    return "challenge"
            elif self.passed():
                return "passed"
            self.watch_anchor(_POLL_MS)

    def wait_for_tiles(self, frame: Frame, after: int, count_hint: int):
        """Wait until the grid tiles show images loaded after the challenge source."""
        tiles = frame.locator("td.rc-imageselect-tile")
        limit = self.clock() + _IMAGE_WAIT_S
        odd: int | None = None  # a non-grid cell count seen on the previous late poll
        while True:
            if self.try_again_later():
                raise _End("try_again_later")
            n = tiles.count()
            late = self.clock() > limit
            # The data's size is a hint: once the wait is over, the DOM's grid wins.
            if n in (9, 16) and (count_hint == 0 or n == count_hint or late):
                src = self.src(tiles.first.locator("img"))
                if self.response_for(src, after) is not None or late:
                    if count_hint and n != count_hint:
                        self.debug("tiles_mismatch", cells=n, size_hint=count_hint)
                    return tiles, n
            elif late and n > 0 and n not in (9, 16):
                # The same non-grid cell count on two polls after the image wait: a
                # challenge type we do not solve. 0 cells means the table is still
                # being rebuilt, so the round keeps waiting until the deadline.
                if odd == n:
                    self.debug("tiles_mismatch", cells=n, size_hint=count_hint)
                    raise _End("label_unsupported")
                odd = n
            else:
                odd = None
            self.wait(_POLL_MS)

    def play_round(self) -> str:
        started = self.clock()
        record: dict = dict(
            grid="3x3", instruction=None, label_id=None, label=None,
            label_source="none", tiles=[], tiles_clicked=[],
        )

        self.round_stage = "challenge_data"
        self.debug("round_start", round=len(self.rounds) + 1)

        def finish(result: str) -> str:
            duration = max(1, int((self.clock() - started) * 1000))
            self.rounds.append(
                RoundRecord(**record, duration_ms=duration, result=result, stage=self.round_stage)
            )
            return result

        try:
            outcome = self._play(record)
        except _Deadline:
            finish("timeout")
            raise
        except _End as end:
            if end.reason in ("label_unsupported", "try_again_later"):
                finish(end.reason)
            else:
                finish("incorrect")
            raise
        except Exception as exc:
            self.error_type = type(exc).__name__
            if self.clock() >= self.deadline - 0.05:  # a capped Playwright wait ran out
                finish("timeout")
                raise _Deadline() from exc
            finish("incorrect")
            raise _End("browser_error") from exc
        self.round_stage = "done"
        return finish(outcome)

    def _play(self, record: dict) -> str:
        source = self.newest_challenge()
        frame = self.bframe()
        if frame is None:
            raise _End("browser_error")
        if source is None and self.awaiting_new is not None:
            # A failed verify: wait for the next challenge's data or new tile images.
            first = frame.locator("td.rc-imageselect-tile img").first
            while source is None:
                if self.try_again_later():
                    raise _End("try_again_later")
                if first.count() and self.src(first) != self.awaiting_new:
                    break
                self.wait(_POLL_MS)
                source = self.newest_challenge()
        self.awaiting_new = None
        self.round_stage = "tiles"
        if source is not None:
            source_index, challenge = source
            label_id, name, size_hint, kind = challenge.label_id, challenge.name, challenge.size, challenge.kind
            self.debug(
                "challenge_data", pmeta_shape=challenge.shape, kind=kind, size_hint=size_hint,
                id_lists=challenge.id_lists,
            )
        else:
            # No fresh challenge data (the page refused the verify itself): use the DOM.
            source_index, label_id, name, size_hint, kind = 0, None, None, 0, None
            self.debug("challenge_data", pmeta_shape=None, kind=None, size_hint=0, id_lists=0)
        record["label_id"] = label_id
        tiles, n = self.wait_for_tiles(frame, source_index, size_hint * size_hint if size_hint else 0)
        self.round_stage = "instruction"
        instruction_el = frame.locator(".rc-imageselect-instructions").first
        instruction = (
            instruction_el.inner_text(timeout=self.left_ms()).strip() if instruction_el.count() else None
        )
        lines = [line for line in (instruction or "").splitlines() if line.strip()]
        if n == 16:
            grid: Grid = "4x4"
        elif kind == "dynamic" or len(lines) == 3:
            grid = "3x3_dynamic"
        else:
            grid = "3x3"
        label, label_source = resolve_label(label_id, name, instruction)
        record.update(grid=grid, instruction=instruction, label=label, label_source=label_source)
        if self.debug_hook is not None:
            self.debug("label_resolved", **self.label_facts(label_id, instruction, label_source))
        if label is None:
            raise _End("label_unsupported")

        self.round_stage = "image"
        image = self.image(tiles.first.locator("img"), frame.locator("table").first, source_index, "grid")
        self.round_stage = "solver"
        try:
            decision = self.solver.solve_grid(label, "4x4" if grid == "4x4" else "3x3", image)
        except (_Deadline, _End):
            raise
        except Exception as exc:
            self.error_type = type(exc).__name__
            raise _End("browser_error") from exc
        if decision is None:
            raise _End("label_unsupported")
        record["tiles"] = list(decision.tiles)

        to_click = [
            i for i, tile in enumerate(decision.tiles[:n])
            if tile.selected != self.is_selected(tiles.nth(i))
        ]
        if grid != "4x4":
            self.rng.shuffle(to_click)
        self.round_stage = "click_tiles"
        self.click_tiles(tiles, to_click, record, delay=grid != "4x4")

        if grid == "3x3_dynamic":
            self.round_stage = "refills"
            self.solve_refills(tiles, to_click, label, record)

        self.round_stage = "verify_click"
        self.wait(850 + self.rng.uniform(0, 300))
        before = dict(
            responses=len(self.responses),
            incorrect=self.visible(frame, ".rc-imageselect-incorrect-response"),
            select_more=self.visible(frame, _SELECT_MORE),
            src=self.src(tiles.first.locator("img")),
        )
        if self.debug_hook is not None:
            self.debug("before_verify", **self.selection_facts(tiles, n, decision.tiles))
        self.click(frame.locator("#recaptcha-verify-button").first)
        self.round_stage = "verify_wait"
        outcome = self.wait_for_verify(frame, tiles, before)
        if self.debug_hook is not None:
            self.debug(
                "verify_result", outcome=outcome,
                incorrect_shown=self.debug_visible(frame, ".rc-imageselect-incorrect-response"),
                select_more_shown=self.debug_visible(frame, _SELECT_MORE),
            )
        return outcome

    def debug_visible(self, frame: Frame, selector: str) -> bool | None:
        """visible() for debug records: None when the frame went away, never an error."""
        try:
            return self.visible(frame, selector)
        except Exception:
            return None

    @staticmethod
    def label_facts(label_id: str | None, instruction: str | None, source: str) -> dict:
        """The id's label against the instruction's label (debug only)."""
        id_label = resolve_label(label_id, None, None)[0] if label_id else None
        text_label = resolve_label(None, None, instruction)[0] if instruction else None
        conflict = None if id_label is None or text_label is None else id_label != text_label
        return {
            "label_source": source, "id_label": id_label, "instruction_label": text_label,
            "label_conflict": conflict,
        }

    def selection_facts(self, tiles, n: int, decided: list[TileRecord]) -> dict:
        """Tile indexes the solver picked and the ones the DOM shows selected (debug only)."""
        try:
            shown = [i for i in range(min(n, tiles.count())) if self.is_selected(tiles.nth(i))]
        except (_Deadline, _End):
            raise
        except Exception as exc:
            return {"cells": n, "selection_error": type(exc).__name__}
        picked = [i for i, tile in enumerate(decided[:n]) if tile.selected]
        return {"cells": n, "picked": picked, "dom_selected": shown}

    def is_selected(self, tile) -> bool:
        return "rc-imageselect-tileselected" in (tile.get_attribute("class", timeout=self.left_ms()) or "")

    def click_tiles(self, tiles, indexes: list[int], record: dict, *, delay: bool) -> None:
        for position, index in enumerate(indexes):
            if delay and position > 0:
                self.wait(300 + self.rng.uniform(0, 300))
            self.click(tiles.nth(index))
            record["tiles_clicked"].append(index)

    def solve_refills(self, tiles, clicked: list[int], label: str, record: dict) -> None:
        pending = sorted(clicked)
        while pending:
            old = {i: self.src(tiles.nth(i).locator("img")) for i in pending}
            limit = self.clock() + _IMAGE_WAIT_S
            while True:
                srcs = {i: self.src(tiles.nth(i).locator("img")) for i in pending}
                if all(srcs[i] != old[i] for i in pending) or self.clock() > limit:
                    break
                self.wait(_POLL_MS)
            images = [self.image(tiles.nth(i).locator("img"), tiles.nth(i), 0, f"tile{i}") for i in pending]
            try:
                decision = self.solver.solve_tiles(label, images)
            except (_Deadline, _End):
                raise
            except Exception as exc:
                self.error_type = type(exc).__name__
                raise _End("browser_error") from exc
            if decision is None:
                raise _End("label_unsupported")
            picks = [pending[j] for j, tile in enumerate(decision.tiles[: len(pending)]) if tile.selected]
            self.rng.shuffle(picks)
            if picks:
                self.wait(300 + self.rng.uniform(0, 300))
            self.click_tiles(tiles, picks, record, delay=True)
            pending = sorted(picks)

    def wait_for_verify(self, frame: Frame, tiles, before: dict) -> str:
        """Solved only on Google's own page signals, never on the userverify reply alone.

        Order: try-again-later; a userverify reply without a token, or a newly shown
        "try again" or "select more" message, means incorrect; a ticked checkbox
        means solved; a vanished widget ends the run as widget_gone; a challenge
        frame that closed or moved offscreen means solved; new tile
        images in a frame that stays visible mean incorrect. A userverify token is
        recorded in debug as supporting evidence only.
        """
        after = before["responses"]
        token_noted = False
        while True:
            outcome = self.verify_outcome(after)
            if outcome == "token" and not token_noted:
                token_noted = True
                self.debug("verify_token")
            if self.try_again_later():
                return "try_again_later"
            if outcome == "incorrect":
                self.source_floor = after
                self.awaiting_new = before["src"]
                return "incorrect"
            if self.visible(frame, _SELECT_MORE) and not before["select_more"]:
                self.source_floor = after  # the old challenge data no longer applies
                return "incorrect"
            if self.visible(frame, ".rc-imageselect-incorrect-response") and not before["incorrect"]:
                self.source_floor = after
                self.awaiting_new = before["src"]
                return "incorrect"
            checked = self.anchor_checked()
            if checked:
                return "solved"
            if checked is None:
                raise _WidgetGone()  # the caller checks the page for the value
            if not self.challenge_visible():
                return "solved"  # closed with no refusal shown; the caller still checks the value
            if not frame.is_detached() and tiles.count() > 0 and self.src(tiles.first.locator("img")) != before["src"]:
                self.source_floor = after
                return "incorrect"
            self.wait(_POLL_MS)


def solve_recaptcha(
    page: Page,
    solver: SolverLike,
    *,
    deadline: float,
    rounds_left: int,
    clock: Callable[[], float] = time.monotonic,
    rng: random.Random | None = None,
    save_image: Callable[[str, bytes], None] | None = None,
    debug: Callable[[str, Page, dict], None] | None = None,
) -> CaptchaResult:
    """Solve the reCAPTCHA on the page within the deadline and round budget.

    `debug`, when set, is called at checkbox click, every 10 s of waiting for the
    widget state, each round start, the round's challenge data (pmeta structure
    only), a grid size mismatch, before and after each verify click, a userverify
    reply that carries a token, and the end of the run (see captcha/debug.py).
    """
    driver = _Driver(page, solver, deadline, rounds_left, clock, rng or random.Random(), save_image, debug)
    page.on("response", driver.on_response)
    try:
        result = driver.run()
        # "done" only for a pass; a returned failure keeps the driver's real stage.
        result.stage = "done" if result.passed else driver.stage
        driver.debug("captcha_end", reason="passed" if result.passed else result.reason)
        return result
    except _Deadline:
        reason: RevealFailureReason = "timeout"
    except _WidgetGone:
        # Auto24 can remove the widget as soon as Google passes the checkbox, before
        # the tick is seen. Reported apart from a pass so the caller checks the page.
        driver.debug("captcha_end", reason="browser_error", widget_gone=True)
        return CaptchaResult(
            False, "browser_error", not driver.challenge_seen, driver.rounds,
            stage=driver.stage, widget_gone=True,
        )
    except _End as end:
        reason = end.reason
    except Exception as exc:
        driver.error_type = type(exc).__name__
        # A capped Playwright wait that ran out is a timeout.
        reason = "timeout" if clock() >= deadline - 0.05 else "browser_error"
    finally:
        try:
            page.remove_listener("response", driver.on_response)
        except Exception:
            pass
    error_type = driver.error_type if reason in ("timeout", "browser_error") else None
    driver.debug("captcha_end", reason=reason)
    return CaptchaResult(False, reason, False, driver.rounds, error_type=error_type, stage=driver.stage)

