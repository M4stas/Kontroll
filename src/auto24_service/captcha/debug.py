"""Opt-in debug recorder for a live reveal: page screenshots plus widget facts.

The hook signature is `debug(event, page, info)`. `info` carries the attempt
number, the frames the driver's URL matching picked and the last click point.
Records hold no values, cookies, tokens, query strings or response bodies: frame
URLs are cut to host and path, and only element classes and attributes the
widget uses for its state are read. Screenshots mask the reg number and VIN
value cells. The rest of the page, such as listing photos and the seller's text,
can still show the plate or VIN.

`info["left_s"]`, when set, is the time left in the attempt. The recorder caps
the screenshot and bounding-box waits to it and skips the screenshot and page
facts when it is short. A few Playwright reads take no timeout, so a hung page
can still delay an attempt.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from playwright.sync_api import Page

DebugHook = Callable[[str, Page, dict], None]

# Value cells of the rows reveal.py reads (tr.field-reg_nr, tr.field-tehasetahis).
# The whole `.value` span is masked: it holds the value text and any link.
MASKED_SELECTORS = ("tr.field-reg_nr .value", "tr.field-tehasetahis .value")

# Below this much time left the recorder writes the event line only.
_MIN_LEFT_S = 2.0

_ANCHOR_STATE = """() => {
    const box = document.querySelector('#recaptcha-anchor');
    const err = document.querySelector('.rc-anchor-error-msg');
    const classes = box ? Array.from(box.classList) : [];
    const spinner = document.querySelector('.recaptcha-checkbox-spinner, [class*="loading"], [class*="spinner"]');
    return {
        aria_checked: box ? box.getAttribute('aria-checked') : null,
        classes: classes,
        error_msg: !!(err && err.textContent.trim()),
        loading: classes.some(c => /loading|spinner/.test(c)) || !!(spinner && spinner.offsetParent !== null),
    };
}"""


# Driver facts copied into events.jsonl: stages, outcomes, tile indexes and the
# challenge data's structure (types, lengths, /m/ label ids). Never values.
_INFO_KEYS = (
    "stage", "reason", "round", "pmeta_shape", "kind", "size_hint", "cells", "picked",
    "dom_selected", "selection_error", "outcome", "incorrect_shown", "select_more_shown",
    "id_lists", "label_source", "id_label", "instruction_label", "label_conflict",
    "widget_gone",
)


def url_part(url: str) -> str:
    """Host and path only: no query string, no fragment."""
    parts = urlsplit(url)
    return f"{parts.netloc}{parts.path}" if parts.netloc else parts.path


def _safe_event(event: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", event.lower()).strip("_") or "event"


class DebugRecorder:
    """Writes `<nn>-<attempt>-<event>.png` and one `events.jsonl` line per call."""

    def __init__(self, folder: Path, clock: Callable[[], float] = time.monotonic) -> None:
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.start = clock()
        self.count = 0
        self.lock = threading.Lock()

    def __call__(self, event: str, page: Page, info: dict | None = None) -> None:
        info = dict(info or {})
        with self.lock:
            self.count += 1
            n = self.count
        attempt = info.get("attempt")
        name = f"{n:02d}-a{attempt if attempt is not None else 0}-{_safe_event(event)}.png"
        record: dict = {
            "t": round(self.clock() - self.start, 3),
            "n": n,
            "attempt": attempt,
            "event": event,
            "screenshot": None,
        }
        left = info.get("left_s")
        if left is not None and left < _MIN_LEFT_S:
            record["skipped"] = "deadline"
        else:
            # Half the time left at most, so the attempt keeps room to finish.
            cap_ms = 5000 if left is None else min(5000, left * 500)
            try:
                page.screenshot(
                    path=str(self.folder / name), full_page=True, timeout=cap_ms,
                    mask=[page.locator(sel) for sel in MASKED_SELECTORS], mask_color="#000000",
                )
                record["screenshot"] = name
            except Exception as exc:
                record["screenshot_error"] = type(exc).__name__
            record.update(page_facts(page, info.get("click"), min(1000, cap_ms / 5)))
        matched = info.get("matched")
        if matched is not None:
            record["matched"] = {k: (url_part(v) if v else None) for k, v in matched.items()}
        for key in _INFO_KEYS:
            if key in info:
                record[key] = info[key]
        line = json.dumps(record, sort_keys=True)
        with self.lock:
            with open(self.folder / "events.jsonl", "a", encoding="utf-8") as fh:
                fh.write(line + "\n")


def page_facts(page: Page, click: tuple[float, float] | None, wait_ms: float = 1000) -> dict:
    facts: dict = {"frames": [], "bframe": None, "anchor": None, "doscaptcha": None, "click_rel_anchor": None}
    try:
        facts["frames"] = [url_part(f.url) for f in page.frames if not f.is_detached()]
    except Exception as exc:
        facts["frames_error"] = type(exc).__name__
    try:
        el = page.locator('iframe[src*="/recaptcha/"][src*="/bframe"]')
        exists = el.count() > 0
        facts["bframe"] = {
            "exists": exists,
            "visible": exists and el.last.is_visible(),
            "box": el.last.bounding_box(timeout=wait_ms) if exists else None,
        }
    except Exception as exc:
        facts["bframe"] = {"error": type(exc).__name__}
    try:
        el = page.locator('iframe[src*="/recaptcha/"][src*="/anchor"]')
        box = el.last.bounding_box(timeout=wait_ms) if el.count() > 0 else None
        if box is not None and click is not None:
            facts["click_rel_anchor"] = [round(click[0] - box["x"], 1), round(click[1] - box["y"], 1),
                                         round(box["width"], 1), round(box["height"], 1)]
    except Exception:
        pass
    anchor = bframe = None
    for frame in page.frames:
        if "/recaptcha/" in frame.url and not frame.is_detached():
            if "/anchor" in frame.url:
                anchor = frame
            elif "/bframe" in frame.url:
                bframe = frame
    if anchor is not None:
        try:
            facts["anchor"] = anchor.evaluate(_ANCHOR_STATE)
        except Exception as exc:
            facts["anchor"] = {"error": type(exc).__name__}
    if bframe is not None:
        try:
            facts["doscaptcha"] = bframe.locator(".rc-doscaptcha-header").count() > 0
        except Exception as exc:
            facts["doscaptcha"] = type(exc).__name__
    return facts
