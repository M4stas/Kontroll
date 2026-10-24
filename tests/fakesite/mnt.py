"""Offline fake Transpordiamet background check pages served through Playwright routes.

The pages copy the ids, button texts, messages and flow of the user's recon session
on 2026-10-22: a search form with reCAPTCHA v3, an AJAX search, the "not in the
register" box, the result page with "Salvestan" and the PDF download. Every value,
key and text body is made up.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from .pdf import identity_pdf
from . import PAGES, SITE_KEY, Scenario, install_fake_site

HOST = "eteenindus.mnt.ee"
SEARCH_URL = f"https://{HOST}/public/soidukTaustakontroll.jsf"
RESULT_URL = f"https://{HOST}/public/soidukDetailvaadeAvalik.jsf"
NOT_FOUND = "Sisestatud andmetega sõidukit registris ei ole!"
SAVE_FIELD = "soidukDetailid:j_idt151"
V3_TOKEN = "fake-v3-token"
TOKEN_FIELD = "soidukOtsingForm:recaptchaResponse"
# PrimeFaces' error box, as the live site showed it on 2026-10-23 for a search posted
# without a usable token.
RECAPTCHA_ERROR = (
    '<div class="ui-messages-error ui-corner-all"><span class="ui-messages-error-icon"></span>'
    '<ul><li><span class="ui-messages-error-summary">reCAPTCHA valideerimise viga</span></li></ul></div>'
)
MAX_PDF_BYTES = 12 * 1024 * 1024


@dataclass
class MntScenario:
    # What the search answers: the result page, the register's refusal, a visible
    # reCAPTCHA v2 challenge (then the result once it is solved), a visible challenge
    # of another kind, the site's "try again later", or nothing at all.
    search: Literal["result", "not_found", "challenge", "unknown_challenge", "try_again_later", "silent"] = "result"
    # Cloudflare's "Just a moment..." page: none, one that clears by itself on the first
    # load, one that clears once Turnstile loads from challenges.cloudflare.com, or one
    # that never clears.
    cloudflare: Literal["none", "clears", "turnstile", "stuck"] = "none"
    result_cloudflare: bool = False  # a Cloudflare page that never clears at the result URL
    form: bool = True  # the search page has the search form
    save_link: bool = True  # the result page has "Salvestan"
    download: Literal["pdf", "not_pdf", "oversized", "other_car", "none"] = "pdf"
    # grecaptcha appears this many ms after api.js loads; negative means never.
    v3_delay_ms: int = 300
    # "rejected": the site answers every token with its reCAPTCHA error.
    token: Literal["accepted", "rejected"] = "accepted"
    reg_value: str = "123ABC"
    vin_value: str = "WVWZZZ1KZAW000001"
    challenge: Scenario = field(default_factory=lambda: Scenario(captcha="challenge"))


@dataclass
class MntLog:
    searches: list[dict[str, str]] = field(default_factory=list)  # posts that carried a token
    tokenless_searches: int = 0  # the button's own post before the token is in
    search_pages: int = 0
    save_fields: list[str] = field(default_factory=list)
    passed: bool = False
    turnstile_loads: int = 0
    requests: list[str] = field(default_factory=list)


def _page(name: str, **values: str) -> str:
    text = (PAGES / name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def _pdf(s: MntScenario) -> bytes:
    if s.download == "not_pdf":
        return f"<html><body>{s.reg_value} {s.vin_value}</body></html>".encode()
    if s.download == "oversized":
        body = identity_pdf(["Registreerimismärk", s.reg_value, "VIN-kood", s.vin_value])
        return body + b"%" + b"0" * (MAX_PDF_BYTES - len(body))
    if s.download == "other_car":
        return identity_pdf(["Sõiduki taustakontroll", "Registreerimismärk", "456DEF", "VIN-kood", "WVWZZZ1KZAW000002"])
    return identity_pdf(["Sõiduki taustakontroll", "Registreerimismärk", s.reg_value, "VIN-kood", s.vin_value])


def install_fake_mnt(context, scenario: MntScenario) -> MntLog:
    """Serve the fake MNT pages; the fake reCAPTCHA v2 frames come from install_fake_site."""
    log = MntLog()
    s = scenario
    google_log = install_fake_site(context, s.challenge)

    def fulfil(route, body, content_type, status=200, headers=None):
        route.fulfill(status=status, body=body, content_type=content_type, headers=headers or {})

    def search_answer() -> dict:
        if s.search == "challenge" and not (log.passed or google_log.passed):
            return {"html": _page("mnt-challenge.html", SITE_KEY=SITE_KEY)}
        if s.search in ("result", "challenge"):
            return {"redirect": RESULT_URL + "?lang=et"}
        if s.search == "not_found":
            return {"html": f'<div class="message message-error"><span class="">{NOT_FOUND}</span></div>'}
        if s.search == "unknown_challenge":
            return {"html": '<iframe title="security check" src="/public/puzzle.html" width="320" height="320"></iframe>'}
        if s.search == "try_again_later":
            return {"html": '<div class="message message-error"><span class="">Palun proovige hiljem uuesti.</span></div>'}
        return {"html": ""}

    def handler(route):
        request = route.request
        parts = urlsplit(request.url)
        if parts.hostname != HOST:
            return route.fallback()
        log.requests.append(request.url)
        path = parts.path
        if path == urlsplit(SEARCH_URL).path and request.method == "GET":
            log.search_pages += 1
            if s.cloudflare == "stuck" or (s.cloudflare in ("clears", "turnstile") and log.search_pages == 1):
                return fulfil(route, _page("mnt-cloudflare.html", MODE=s.cloudflare), "text/html; charset=utf-8", status=403)
            return fulfil(route, _page("mnt-search.html", FORM="1" if s.form else "0"), "text/html; charset=utf-8")
        if path == urlsplit(SEARCH_URL).path and request.method == "POST":
            form = {key: values[0] for key, values in parse_qs(request.post_data or "", keep_blank_values=True).items()}
            if not form.get(TOKEN_FIELD):
                log.tokenless_searches += 1
                return fulfil(route, json.dumps({"messages": RECAPTCHA_ERROR}), "application/json; charset=utf-8")
            log.searches.append(form)
            answer = {"messages": RECAPTCHA_ERROR} if s.token == "rejected" else {"messages": "", **search_answer()}
            return fulfil(route, json.dumps(answer), "application/json; charset=utf-8")
        if path == urlsplit(RESULT_URL).path and request.method == "GET":
            if s.result_cloudflare:
                return fulfil(route, _page("mnt-cloudflare.html", MODE="stuck"), "text/html; charset=utf-8", status=403)
            return fulfil(route, _page(
                "mnt-result.html", REG=s.reg_value, VIN=s.vin_value, SAVE="1" if s.save_link else "0",
            ), "text/html; charset=utf-8")
        if path == urlsplit(RESULT_URL).path and request.method == "POST":
            form = parse_qs(request.post_data or "")
            log.save_fields.extend(key for key in form if key.startswith("soidukDetailid:") and not key.endswith("_active"))
            if s.download == "none" or SAVE_FIELD not in form:
                return fulfil(route, "<html><body>Viga</body></html>", "text/html; charset=utf-8")
            return fulfil(route, _pdf(s), "application/pdf; charset=utf-8", headers={
                "Content-Disposition": f'attachment;filename="DETAILANDMED_{s.reg_value}.pdf"',
            })
        if path == "/services/data_json.php":
            # The fake v2 widget posts its token here once the challenge is solved.
            log.passed = True
            return fulfil(route, "{}", "application/json")
        if path == "/public/puzzle.html":
            return fulfil(route, "<html><body><canvas width=300 height=300></canvas></body></html>", "text/html")
        return fulfil(route, b"", "text/plain", status=404)

    def v3(route):
        # reCAPTCHA v3 api.js: grecaptcha appears after the scenario's delay, and
        # execute() then resolves at once with a fake token.
        query = parse_qs(urlsplit(route.request.url).query)
        if query.get("render", ["explicit"])[0] == "explicit":
            return route.fallback()
        log.requests.append(route.request.url)
        return fulfil(route, _page("mnt-v3.js", TOKEN=V3_TOKEN, DELAY_MS=str(s.v3_delay_ms)), "text/javascript")

    def turnstile(route):
        # Turnstile's api.js: clears the challenge at once by reloading the page.
        log.turnstile_loads += 1
        return fulfil(route, "location.reload();", "text/javascript")

    context.route("https://www.google.com/recaptcha/api.js*", v3)
    context.route("https://challenges.cloudflare.com/turnstile/**", turnstile)
    context.route("**/*", handler)
    return log
