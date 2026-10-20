"""Offline fake Auto24 listing and reCAPTCHA frames served through Playwright routes.

All pages and scripts here are our own minimal test code. Values, data keys and the
site key are made up.
"""

from __future__ import annotations

import io
import json
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw

LISTING_URL = "https://www.auto24.ee/soidukid/900001"
SITE_KEY = "6LfakeSiteKeyForOfflineTests000000000000"
REG_KEY = "a1" * 32
VIN_KEY = "b2" * 32
REG_IKEY = "c3" * 40
VIN_IKEY = "d4" * 40
ANCHOR_TOKEN = "fake-anchor-token"
VERIFY_TOKEN = "fake-uvresp-token"

PAGES = Path(__file__).parent / "pages"
AUTO24 = "www.auto24.ee"
GOOGLE = "www.google.com"
XSSI = ")]}'\n"


@dataclass
class Scenario:
    reg: Literal["hidden", "full", "missing", "invalid"] = "hidden"
    vin: Literal["hidden", "full", "missing", "link_only", "full_with_link", "invalid"] = "hidden"
    reg_value: str = "123ABC"
    reg_prefix: str | None = "123..."
    vin_value: str = "WVWZZZ1KZAW000001"
    vin_prefix: str | None = "WVWZZZ..."
    captcha: Literal["none", "checkbox_only", "challenge"] = "challenge"
    grid: Literal["3x3", "3x3_dynamic", "4x4"] = "3x3"
    incorrect_rounds: int = 0
    try_again_later: bool = False
    hang_checkbox: bool = False
    remove_widget: bool = False  # checkbox click removes the widget row without a token
    incorrect_inline: bool = False  # failed verifies carry the next challenge, no reload
    select_more_rounds: int = 0  # first N verify clicks are refused client-side
    vin_needs_captcha: bool = False
    label_id: str | None = "/m/0k4j"
    label_name: str | None = "Car"
    instruction: str = "Select all images with cars"
    refuse_reveal: bool = False
    refuse_token: bool = False  # Auto24 refuses the posted CAPTCHA token, but not the trigger
    extra_request: str | None = None
    reg_page_value: str | None = None  # page shows this instead of the JSON reg value
    pmeta: list | None = None  # raw pmeta entry for reload bodies; None: the 3x3 layout
    dom_size: int | None = None  # grid rows the challenge DOM shows; None: from `grid`
    refill_mode: str = "immediate"  # immediate, staggered, unloaded, never
    rebuild_delay_ms: int = 0  # after a failed verify, show no cells this long before the next grid
    # First N verifies get a userverify token but the frame still refuses: it keeps
    # the challenge open and loads a new one, showing "try again" when decoy_shows_incorrect.
    decoy_token_rounds: int = 0
    decoy_shows_incorrect: bool = True
    pass_hides_bframe: Literal["visibility", "offscreen"] = "visibility"  # how a passed challenge closes
    pass_ticks_anchor: bool = True  # a verify pass ticks the checkbox
    pass_submit_delay_ms: int = 0  # delay before the page posts a verify token (and then drops the widget)
    # After a verify pass the page removes the widget row before the tick: with the
    # token posted ("with_value") or without ("no_value").
    verify_vanish: Literal["none", "with_value", "no_value"] = "none"
    vanish_on_pass: bool = False  # checkbox_only: the row goes before the tick shows, then the token posts
    second_widget_mode: str | None = None  # anchor mode for widgets after the first (e.g. "vanish")
    challenge_ids: list[str] | None = None  # challenge id per verify count; default fake-challenge-N
    repeat_replies: int = 1  # the challenge frame asks for each challenge this many times
    silent_after_s: float | None = None  # reload and userverify get no reply after this long
    unknown_replies: bool = False  # userverify replies come in a format the watcher does not know
    keep_widget: bool = False  # the value reply leaves the CAPTCHA widget row in place


@dataclass
class FakeSiteLog:
    requests: list[str] = field(default_factory=list)
    verifies: int = 0
    clicked_tiles: list[list[int]] = field(default_factory=list)
    posted_tokens: int = 0
    fallbacks: list[str] = field(default_factory=list)
    reloads: int = 0
    passed: bool = False


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _trigger(action: str, key: str, label: str) -> str:
    return f'<span class="color-link service-trigger" data-action="{action}" data-key="{key}">{label}</span>'


def _preview(prefix: str | None) -> str:
    return "" if prefix is None else f'<span class="preview">{_esc(prefix)}</span>'


def _reg_row(s: Scenario) -> str:
    if s.reg == "missing":
        return ""
    if s.reg == "full":
        value = _esc(s.reg_value)
    elif s.reg == "invalid":
        value = "N/A"
    else:
        value = _preview(s.reg_prefix) + _trigger("uv_regnr", REG_KEY, "näita reg. nr.")
    return (
        '        <tr class="field-reg_nr"><td class="label"><span>Reg. number</span></td>'
        f'<td class="field"><span class="value">{value}</span></td></tr>'
    )


def _vin_row(s: Scenario) -> str:
    if s.vin == "missing":
        return ""
    if s.vin == "link_only":
        # Real listings can show only a history-check link: no VIN, no trigger.
        return (
            '        <tr class="field-tehasetahis"><td class="label">VIN-kood</td><td class="field">'
            '<span class="value"><a href="#">Kontrolli ajalugu</a></span></td></tr>'
        )
    if s.vin == "full_with_link":
        return (
            '        <tr class="field-tehasetahis"><td class="label">VIN-kood</td><td class="field">'
            f'<span class="value">{_esc(s.vin_value)} <a href="#">Kontrolli ajalugu</a></span></td></tr>'
        )
    if s.vin == "invalid":
        return (
            '        <tr class="field-tehasetahis"><td class="label">VIN-kood</td><td class="field">'
            '<span class="value">N/A</span></td></tr>'
        )
    if s.vin == "full":
        inner = _esc(s.vin_value)
    else:
        inner = _preview(s.vin_prefix) + _trigger("uv_vin", VIN_KEY, "näita VIN")
    return (
        '        <tr class="field-tehasetahis"><td class="label">VIN-kood</td><td class="field">'
        f'<span class="value"><span class="-response">{inner}</span></span></td></tr>'
    )


def _captcha_rows(field_class: str, label: str, action: str, ikey: str, germ: str) -> str:
    value_inner = '<span class="-response"></span>' if field_class == "field-tehasetahis" else ""
    return (
        f'<tr class="{field_class}"><td class="label">{label}</td><td class="field"><span class="value">{value_inner}</span></td></tr>'
        f'<tr class="sub-field {field_class}-gc2"><td colspan="2">'
        '<script src="https://www.google.com/recaptcha/api.js?onload=reCapLiveRender&render=explicit&hl=et" async defer></script>'
        f'<form id="{germ}-sec" action="#" class="service-trigger clearfix" data-mode="f" data-action="{action}" '
        f'data-key="{germ}-sec" method="POST"><div class="cptch-wrapper">'
        f'<div id="reCapLive-{germ}" class="germ" data-sk="{SITE_KEY}"></div>'
        f'<input type="hidden" name="ikey" value="{ikey}"></div></form></td></tr>'
    )


def _q(status: int, response: dict | None = None) -> str:
    return json.dumps({"q": {"status": status, "response": response or {}, "i": 0}})


def _value(value: str, redraw: str, gc2: str, page_value: str | None = None, keep_widget: bool = False) -> dict:
    extra = {} if page_value is None else {"page_value": page_value}
    return {
        **extra,
        "value": value,
        "redraw": redraw,
        "remove_trigger": 1,
        "callback": [] if keep_widget else [{"fn": "replaceSelectorWithContent", "args": [gc2, ""]}],
    }


@lru_cache(maxsize=None)
def _jpeg(size: int, shade: int) -> bytes:
    image = Image.new("RGB", (size, size), (40 + shade * 37 % 200, 90, 160 - shade * 23 % 120))
    draw = ImageDraw.Draw(image)
    step = max(size // 6, 10)
    for x in range(0, size, step):
        draw.line([(x, 0), (x, size)], fill=(230, 230, 230), width=2)
    image_bytes = io.BytesIO()
    image.save(image_bytes, format="JPEG", quality=80)
    return image_bytes.getvalue()


def _page(name: str, **values: str) -> str:
    text = (PAGES / name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def _js_string(value: str) -> str:
    # Value goes inside a double-quoted JS string literal.
    return json.dumps(value)[1:-1].replace("</", "<\\/")


def install_fake_site(context, scenario: Scenario) -> FakeSiteLog:
    """Serve the fake listing and reCAPTCHA through one context route."""
    log = FakeSiteLog()
    s = scenario
    installed = time.monotonic()
    grid_size = 4 if s.grid == "4x4" else 3
    image_size = 450 if grid_size == 4 else 300

    def fulfil(route, body, content_type, status=200):
        route.fulfill(status=status, body=body, content_type=content_type)

    def json_reply(route, text):
        fulfil(route, text, "application/json; charset=utf-8")

    def google_reply(route, payload):
        fulfil(route, XSSI + json.dumps(payload), "application/json; charset=utf-8")

    def data_json(route, request, query):
        if request.method == "POST":
            form = parse_qs(request.post_data or "")
            q = form.get("q", [""])[0]
            inner = parse_qs(form.get("k", [""])[0])
            token = inner.get("g-recaptcha-response", [""])[0]
            ikey = inner.get("ikey", [""])[0]
            log.posted_tokens += 1
            if token not in (ANCHOR_TOKEN, VERIFY_TOKEN) or s.refuse_reveal or s.refuse_token:
                return json_reply(route, _q(0))
            if q == "uv_regnr_sec" and ikey == REG_IKEY:
                log.passed = True
                return json_reply(route, _q(1, _value(s.reg_value, ".field-reg_nr .value", ".sub-field.field-reg_nr-gc2", s.reg_page_value, s.keep_widget)))
            if q == "uv_vin_sec" and ikey == VIN_IKEY:
                log.passed = True
                return json_reply(
                    route, _q(1, _value(s.vin_value, ".field-tehasetahis .value .-response", ".sub-field.field-tehasetahis-gc2"))
                )
            return json_reply(route, _q(0))
        q = query.get("q", [""])[0]
        k = query.get("k", [""])[0]
        if s.refuse_reveal:
            return json_reply(route, _q(0))
        if q == "uv_regnr" and k == REG_KEY:
            if s.captcha == "none" or log.passed:
                return json_reply(route, _q(1, _value(s.reg_value, ".field-reg_nr .value", ".sub-field.field-reg_nr-gc2", s.reg_page_value)))
            html = _captcha_rows("field-reg_nr", "Reg. number", "uv_regnr_sec", REG_IKEY, "23dd67")
            return json_reply(route, _q(1, {"value": html, "redraw": "", "remove_trigger": 1, "replace": ".field-reg_nr"}))
        if q == "uv_vin" and k == VIN_KEY:
            if s.captcha == "none" or (log.passed and not s.vin_needs_captcha):
                return json_reply(
                    route,
                    _q(1, _value(s.vin_value, ".field-tehasetahis .value .-response", ".sub-field.field-tehasetahis-gc2")),
                )
            html = _captcha_rows("field-tehasetahis", "VIN-kood", "uv_vin_sec", VIN_IKEY, "9c41b0")
            return json_reply(
                route, _q(1, {"value": html, "redraw": "", "remove_trigger": 1, "replace": ".field-tehasetahis"})
            )
        return json_reply(route, _q(0))

    def challenge_id():
        if s.challenge_ids is not None and log.verifies < len(s.challenge_ids):
            return s.challenge_ids[log.verifies]
        return f"fake-challenge-{log.verifies}"

    def reload_payload():
        if s.try_again_later:
            return ["rresp", None, None, 120, None, "doscaptcha"]
        pmeta = s.pmeta if s.pmeta is not None else [
            "pmeta", [s.label_id, None, grid_size, grid_size, grid_size, None, s.label_name]
        ]
        kind = "dynamic" if s.grid == "3x3_dynamic" else "imageselect"
        return ["rresp", challenge_id(), None, 120, pmeta, kind]

    def google_verify(route, payload):
        if s.unknown_replies:
            payload = ["xresp"] + payload[1:]
        google_reply(route, payload)

    def userverify(route, request):
        form = parse_qs(request.post_data or "")
        try:
            tiles = [int(t) for t in json.loads(form.get("response", ["[]"])[0])]
        except (ValueError, TypeError):
            tiles = []
        log.clicked_tiles.append(tiles)
        log.verifies += 1
        if log.verifies <= s.decoy_token_rounds:
            # A token in [1], yet the frame treats [2] == 0 as a refusal.
            return google_verify(route, ["uvresp", "fake-decoy-token", 0, 120])
        if log.verifies > s.incorrect_rounds + s.decoy_token_rounds:
            return google_verify(route, ["uvresp", VERIFY_TOKEN, 1, 120])
        if s.incorrect_inline:
            return google_verify(route, ["uvresp", None, None, None] + reload_payload()[4:])
        return google_verify(route, ["uvresp", None, None, None])

    def silent() -> bool:
        return s.silent_after_s is not None and time.monotonic() - installed >= s.silent_after_s

    def handler(route):
        request = route.request
        url = request.url
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        host, path = parts.hostname, parts.path
        log.requests.append(url)
        if host == AUTO24:
            if url.split("#")[0] == LISTING_URL:
                html = _page("listing.html", REG_ROW=_reg_row(s), VIN_ROW=_vin_row(s))
                return fulfil(route, html, "text/html; charset=utf-8")
            if path == "/services/data_json.php":
                return data_json(route, request, query)
            if path == "/favicon.ico":
                return fulfil(route, b"", "image/x-icon", status=404)
        if host == "img-bcg.eu" and path.endswith(".jpg"):
            return fulfil(route, _jpeg(300, 0), "image/jpeg")
        if host == GOOGLE:
            if path == "/recaptcha/api.js":
                return fulfil(route, _page(
                    "api.js", EXTRA_REQUEST=_js_string(s.extra_request or ""), PASS_HIDE=s.pass_hides_bframe,
                    PASS_TICK="1" if s.pass_ticks_anchor else "0", VERIFY_VANISH=s.verify_vanish,
                    PASS_DELAY=str(s.pass_submit_delay_ms),
                ), "text/javascript")
            if path == "/recaptcha/api2/anchor":
                mode = "hang" if s.hang_checkbox else "vanish" if s.remove_widget else s.captcha
                if s.vanish_on_pass and s.captcha == "checkbox_only":
                    mode = "pass_vanish"
                if s.second_widget_mode and query.get("cb", ["0"])[0] != "0":
                    mode = s.second_widget_mode
                return fulfil(route, _page("anchor.html", MODE=mode, TOKEN=ANCHOR_TOKEN), "text/html; charset=utf-8")
            if path == "/recaptcha/api2/bframe":
                return fulfil(route, _page(
                    "bframe.html", INSTRUCTION=_js_string(s.instruction), SELECT_MORE=str(s.select_more_rounds),
                    GRID_SIZE=str(s.dom_size or grid_size), REBUILD_DELAY=str(s.rebuild_delay_ms),
                    REFILL_MODE=s.refill_mode,
                    DECOY_INCORRECT="1" if s.decoy_shows_incorrect else "0",
                    REPEAT=str(s.repeat_replies),
                ), "text/html; charset=utf-8")
            if path in ("/recaptcha/api2/reload", "/recaptcha/api2/userverify") and silent():
                return None  # never answered: the request stays pending
            if path == "/recaptcha/api2/reload" and request.method == "POST":
                log.reloads += 1
                return google_reply(route, reload_payload())
            if path == "/recaptcha/api2/userverify" and request.method == "POST":
                return userverify(route, request)
            if path == "/recaptcha/api2/payload":
                round_ = int(query.get("p", ["0"])[0] or 0)
                if "id" in query:
                    return fulfil(route, _jpeg(100, round_ + int(query["id"][0]) + 7 + int(query.get("generation", ["1"])[0]) - 1), "image/jpeg")
                return fulfil(route, _jpeg(image_size, round_), "image/jpeg")
            if path == "/favicon.ico":
                return fulfil(route, b"", "image/x-icon", status=404)
        log.fallbacks.append(url)
        return route.fallback()

    context.route("**/*", handler)
    return log
