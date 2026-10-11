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

Grid = Literal["3x3", "3x3_dynamic", "4x4"]


@dataclass
class CaptchaResult:
    passed: bool
    reason: RevealFailureReason | None
    checkbox_only: bool
    rounds: list[RoundRecord] = field(default_factory=list)


class _Deadline(Exception):
    pass


class _End(Exception):
    def __init__(self, reason: RevealFailureReason) -> None:
        super().__init__(reason)
        self.reason = reason


def _frame(page: Page, part: str) -> Frame | None:
    for frame in page.frames:
        if "/recaptcha/" in frame.url and part in frame.url:
            return frame
    return None


class _Driver:
    def __init__(self, page, solver, deadline, rounds_left, clock, rng, save_image) -> None:
        self.page = page
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

    # --- plumbing -------------------------------------------------------------

    def on_response(self, response: Response) -> None:
        match = _WATCHED.search(response.url)
        if match:
            self.responses.append((match.group(1), response.url, response))

    def wait(self, ms: float) -> None:
        if self.clock() + ms / 1000 > self.deadline:
            raise _Deadline()
        self.page.wait_for_timeout(ms)

    def click(self, locator) -> None:
        box = locator.bounding_box()
        if box is None:
            raise _End("browser_error")
        x = box["x"] + box["width"] * self.rng.uniform(0.25, 0.75)
        y = box["y"] + box["height"] * self.rng.uniform(0.25, 0.75)
        self.page.mouse.click(x, y)

    def reload_count(self) -> int:
        return sum(1 for kind, _, _ in self.responses if kind == "reload")

    def anchor_checked(self) -> bool:
        """True once the checkbox is ticked, or once the site removed the ticked widget."""
        anchor = _frame(self.page, "/anchor")
        if anchor is None:
            # The page swaps the widget out after it accepts the token.
            return True
        try:
            return anchor.locator("#recaptcha-anchor").get_attribute("aria-checked", timeout=500) == "true"
        except Exception:
            return False

    def bframe(self) -> Frame | None:
        return _frame(self.page, "/bframe")

    def challenge_visible(self) -> bool:
        el = self.page.locator('iframe[src*="/recaptcha/"][src*="/bframe"]')
        return el.count() > 0 and el.first.is_visible()

    def try_again_later(self) -> bool:
        frame = self.bframe()
        return frame is not None and frame.locator(".rc-doscaptcha-header").first.is_visible()

    def response_for(self, url: str, after: int = 0) -> Response | None:
        for kind, seen, response in reversed(self.responses[after:]):
            if seen == url and kind in ("payload", "replaceimage"):
                return response
        return None

    def image(self, img, fallback, after: int, name: str) -> bytes:
        src = img.evaluate("e => e.src")
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
            data = fallback.screenshot()
        if self.save_image is not None:
            self.images_saved += 1
            self.save_image(f"{self.images_saved:03d}-{name}", data)
        return data

    # --- flow -----------------------------------------------------------------

    def run(self) -> CaptchaResult:
        self.open_checkbox()
        verifies = 0
        while True:
            state = self.wait_for_state()
            if state == "passed":
                return CaptchaResult(True, None, not self.challenge_seen, self.rounds)
            if state == "try_again_later":
                return CaptchaResult(False, "try_again_later", False, self.rounds)
            if verifies >= self.rounds_left:
                return CaptchaResult(False, "captcha_rounds_exhausted", False, self.rounds)
            outcome = self.play_round()
            verifies += 1
            if outcome == "solved":
                return CaptchaResult(True, None, False, self.rounds)
            if outcome == "try_again_later":
                return CaptchaResult(False, "try_again_later", False, self.rounds)
            if verifies >= self.rounds_left:
                return CaptchaResult(False, "captcha_rounds_exhausted", False, self.rounds)

    def open_checkbox(self) -> None:
        while True:
            anchor = _frame(self.page, "/anchor")
            if anchor is not None:
                box = anchor.locator("#recaptcha-anchor")
                if box.count() > 0 and box.first.is_visible():
                    self.click(box.first)
                    return
            if self.clock() + _POLL_MS / 1000 > self.deadline:
                raise _End("widget_not_found")
            self.page.wait_for_timeout(_POLL_MS)

    def wait_for_state(self) -> str:
        """Wait for a pass, a try-again-later screen or a challenge with its reload."""
        handled = getattr(self, "handled_reloads", 0)
        while True:
            if self.anchor_checked():
                return "passed"
            if self.challenge_visible():
                self.challenge_seen = True
                if self.try_again_later():
                    return "try_again_later"
                if self.reload_count() > handled:
                    return "challenge"
            self.wait(_POLL_MS)

    def newest_reload(self) -> tuple[int, list]:
        for index in range(len(self.responses) - 1, -1, -1):
            kind, _, response = self.responses[index]
            if kind == "reload":
                text = response.text()
                if text.startswith(")]}'"):
                    text = text.split("\n", 1)[1] if "\n" in text else ""
                return index, json.loads(text)
        raise _End("browser_error")

    def wait_for_tiles(self, frame: Frame, after: int, count_hint: int):
        """Wait until the grid tiles show images loaded after the reload."""
        tiles = frame.locator("td.rc-imageselect-tile")
        limit = self.clock() + _IMAGE_WAIT_S
        while True:
            if self.try_again_later():
                raise _End("try_again_later")
            n = tiles.count()
            if n in (9, 16) and (count_hint == 0 or n == count_hint):
                src = tiles.first.locator("img").evaluate("e => e.src")
                if self.response_for(src, after) is not None or self.clock() > limit:
                    return tiles, n
            self.wait(_POLL_MS)

    def play_round(self) -> str:
        started = self.clock()
        self.handled_reloads = self.reload_count()
        reload_index, data = self.newest_reload()
        meta = data[4][1] if len(data) > 4 and isinstance(data[4], list) and len(data[4]) > 1 else []
        label_id = meta[0] if len(meta) > 0 else None
        name = meta[6] if len(meta) > 6 else None
        size_hint = meta[2] if len(meta) > 2 and isinstance(meta[2], int) else 0
        kind = data[5] if len(data) > 5 else None

        frame = self.bframe()
        if frame is None:
            raise _End("browser_error")
        try:
            tiles, n = self.wait_for_tiles(frame, reload_index, size_hint * size_hint if size_hint else 0)
        except _End as end:
            if end.reason == "try_again_later":
                self.rounds.append(RoundRecord(
                    grid="3x3", instruction=None, label_id=label_id, label=None, label_source="none",
                    tiles=[], tiles_clicked=[], duration_ms=max(1, int((self.clock() - started) * 1000)),
                    result="try_again_later",
                ))
            raise
        instruction_el = frame.locator(".rc-imageselect-instructions").first
        instruction = instruction_el.inner_text().strip() if instruction_el.count() else None
        lines = [line for line in (instruction or "").splitlines() if line.strip()]
        if n == 16:
            grid: Grid = "4x4"
        elif kind == "dynamic" or len(lines) == 3:
            grid = "3x3_dynamic"
        else:
            grid = "3x3"
        label, source = resolve_label(label_id, name, instruction)

        record = dict(
            grid=grid, instruction=instruction, label_id=label_id, label=label,
            label_source=source, tiles=[], tiles_clicked=[],
        )

        def finish(result: str) -> str:
            duration = max(1, int((self.clock() - started) * 1000))
            self.rounds.append(RoundRecord(**record, duration_ms=duration, result=result))
            return result

        if label is None:
            finish("label_unsupported")
            raise _End("label_unsupported")

        try:
            try:
                image = self.image(tiles.first.locator("img"), frame.locator("table").first, reload_index, "grid")
                decision = self.solver.solve_grid(label, "4x4" if grid == "4x4" else "3x3", image)
            except (_Deadline, _End):
                raise
            except Exception:
                raise _End("browser_error")
            if decision is None:
                raise _End("label_unsupported")
            record["tiles"] = list(decision.tiles)

            to_click = [
                i for i, tile in enumerate(decision.tiles[:n])
                if tile.selected != self.is_selected(tiles.nth(i))
            ]
            if grid != "4x4":
                self.rng.shuffle(to_click)
            self.click_tiles(tiles, to_click, record, delay=grid != "4x4")

            if grid == "3x3_dynamic":
                self.solve_refills(tiles, to_click, label, record)

            self.wait(850 + self.rng.uniform(0, 300))
            reloads_before = self.reload_count()
            self.click(frame.locator("#recaptcha-verify-button").first)
            outcome = self.wait_for_verify(reloads_before)
        except _Deadline:
            finish("timeout")
            raise
        except _End as end:
            finish(end.reason if end.reason in ("label_unsupported", "try_again_later") else "incorrect")
            raise
        return finish(outcome)

    def is_selected(self, tile) -> bool:
        return "rc-imageselect-tileselected" in (tile.get_attribute("class") or "")

    def click_tiles(self, tiles, indexes: list[int], record: dict, *, delay: bool) -> None:
        for position, index in enumerate(indexes):
            if delay and position > 0:
                self.wait(300 + self.rng.uniform(0, 300))
            self.click(tiles.nth(index))
            record["tiles_clicked"].append(index)

    def solve_refills(self, tiles, clicked: list[int], label: str, record: dict) -> None:
        pending = sorted(clicked)
        while pending:
            old = {i: tiles.nth(i).locator("img").evaluate("e => e.src") for i in pending}
            limit = self.clock() + _IMAGE_WAIT_S
            while True:
                srcs = {i: tiles.nth(i).locator("img").evaluate("e => e.src") for i in pending}
                if all(srcs[i] != old[i] for i in pending) or self.clock() > limit:
                    break
                self.wait(_POLL_MS)
            images = []
            for i in pending:
                images.append(self.image(tiles.nth(i).locator("img"), tiles.nth(i), 0, f"tile{i}"))
            try:
                decision = self.solver.solve_tiles(label, images)
            except (_Deadline, _End):
                raise
            except Exception:
                raise _End("browser_error")
            if decision is None:
                raise _End("label_unsupported")
            picks = [pending[j] for j, tile in enumerate(decision.tiles[: len(pending)]) if tile.selected]
            self.rng.shuffle(picks)
            if picks:
                self.wait(300 + self.rng.uniform(0, 300))
            self.click_tiles(tiles, picks, record, delay=True)
            pending = sorted(picks)

    def wait_for_verify(self, reloads_before: int) -> str:
        while True:
            if self.anchor_checked():
                return "solved"
            if self.try_again_later():
                return "try_again_later"
            if self.reload_count() > reloads_before:
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
) -> CaptchaResult:
    """Solve the reCAPTCHA on the page within the deadline and round budget."""
    driver = _Driver(page, solver, deadline, rounds_left, clock, rng or random.Random(), save_image)
    page.on("response", driver.on_response)
    try:
        return driver.run()
    except _Deadline:
        return CaptchaResult(False, "timeout", False, driver.rounds)
    except _End as end:
        return CaptchaResult(False, end.reason, False, driver.rounds)
    except Exception:
        return CaptchaResult(False, "browser_error", False, driver.rounds)
    finally:
        try:
            page.remove_listener("response", driver.on_response)
        except Exception:
            pass
