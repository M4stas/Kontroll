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

from ..contracts import RevealFailureReason, RoundRecord, TileRecord
from .labels import resolve_label
from .solver import SolverLike

_WATCHED = re.compile(r"/recaptcha/(?:api2|enterprise)/(reload|payload|userverify|replaceimage)")
_POLL_MS = 200
_IMAGE_WAIT_S = 6.0
_CHALLENGE_KINDS = ("imageselect", "dynamic", "multicaptcha", "tileselect")
_SELECT_MORE = ".rc-imageselect-error-select-more, .rc-imageselect-error-dynamic-more"

Grid = Literal["3x3", "3x3_dynamic", "4x4"]


@dataclass
class CaptchaResult:
    passed: bool
    reason: RevealFailureReason | None
    checkbox_only: bool
    rounds: list[RoundRecord] = field(default_factory=list)
    error_type: str | None = None  # exception class name, never the message
    stage: str | None = None  # where the driver was when it ended (ATTEMPT_STAGES)


class _Deadline(Exception):
    pass


class _End(Exception):
    def __init__(self, reason: RevealFailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


def _google_json(text: str):
    if text.startswith(")]}'"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    return json.loads(text)


def _challenge_parts(data) -> tuple[list, str | None] | None:
    """Return (pmeta values, challenge type) when a reload or userverify body carries a challenge."""
    if not isinstance(data, list):
        return None
    meta = next((x[1] for x in data if isinstance(x, list) and len(x) > 1 and x[0] == "pmeta"), None)
    if not isinstance(meta, list):
        return None
    kind = next((x for x in data if isinstance(x, str) and x in _CHALLENGE_KINDS), None)
    return meta, kind


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
        self.verified_token = False
        self.source_floor = 0  # challenge data before this response index is stale
        self.verify_after: int | None = None  # response index of the latest verify click
        self.awaiting_new: str | None = None  # first tile src of a challenge Google is replacing
        self.stage = "captcha_checkbox"  # ATTEMPT_STAGES value
        self.round_stage: str | None = None  # ROUND_STAGES value of the current round
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

    def passed(self) -> bool:
        """Positive evidence only: a ticked checkbox or a userverify token, on the same page."""
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
                return False
        if self.anchor_was_checked or self.verified_token:
            return True
        if anchor is None and self.page_saw_tick():
            self.anchor_was_checked = True
            return True
        if self.verify_after is not None and self.verify_outcome(self.verify_after) == "solved":
            return True  # the token arrived in the same poll interval the widget was removed
        if anchor is None:
            raise _End("browser_error")  # widget vanished without evidence of a pass
        return False

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
        el = self.page.locator('iframe[src*="/recaptcha/"][src*="/bframe"]')
        return el.count() > 0 and el.last.is_visible()

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

    def newest_challenge(self) -> tuple[int, list, str | None] | None:
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
                return index, parts[0], parts[1]
        return None

    def verify_outcome(self, after: int) -> str | None:
        """Read the first userverify response after a verify click: token means solved."""
        for kind, _, response in self.responses[after:]:
            if kind != "userverify":
                continue
            try:
                data = _google_json(response.text())
            except Exception:
                return None
            if isinstance(data, list) and len(data) > 1 and isinstance(data[1], str) and data[1]:
                self.verified_token = True
                return "solved"
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
        while True:
            if self.try_again_later():
                raise _End("try_again_later")
            n = tiles.count()
            if n in (9, 16) and (count_hint == 0 or n == count_hint):
                src = self.src(tiles.first.locator("img"))
                if self.response_for(src, after) is not None or self.clock() > limit:
                    return tiles, n
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
            source_index, meta, kind = source
            label_id = meta[0] if len(meta) > 0 else None
            name = meta[6] if len(meta) > 6 else None
            size_hint = meta[2] if len(meta) > 2 and isinstance(meta[2], int) else 0
        else:
            # No fresh challenge data (the page refused the verify itself): use the DOM.
            source_index, label_id, name, size_hint, kind = 0, None, None, 0, None
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
        self.verify_after = before["responses"]
        self.click(frame.locator("#recaptcha-verify-button").first)
        self.round_stage = "verify_wait"
        return self.wait_for_verify(frame, tiles, before)

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
        """Outcome order: userverify token or failure, try-again-later, DOM refusal signals, checkbox."""
        after = before["responses"]
        while True:
            outcome = self.verify_outcome(after)
            if outcome == "solved":
                return "solved"
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
            if tiles.count() > 0 and self.src(tiles.first.locator("img")) != before["src"]:
                self.source_floor = after
                return "incorrect"
            if self.passed():
                return "solved"
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
    widget state, each round start and the end of the run (see captcha/debug.py).
    """
    driver = _Driver(page, solver, deadline, rounds_left, clock, rng or random.Random(), save_image, debug)
    page.on("response", driver.on_response)
    try:
        result = driver.run()
        result.stage = "done"
        driver.debug("captcha_end", reason="passed")
        return result
    except _Deadline:
        reason: RevealFailureReason = "timeout"
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

