"""Transpordiamet background check lookup: search by one identity value, keep the PDF.

The driver opens the public search page with the MNT allowlist, fills either the
registration number or the VIN field, presses "Otsin", and on the result page presses
the first "Salvestan" and takes the PDF from the download event. reCAPTCHA v3 needs no
clicks. A visible reCAPTCHA v2 challenge is left to the CaptchaRaptor extension, as on
Auto24; any other visible challenge ends the attempt. Selectors use stable ids and the
visible button texts, never generated `j_idt` ids (spec decision 10).
"""

from __future__ import annotations

import functools
import re
import time
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from .contracts import BackgroundCheckReason, SearchKind
from .pdf_check import MAX_PDF_BYTES, pdf_matches

SEARCH_URL = "https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf"
RESULT_PATH = "/public/soidukDetailvaadeAvalik.jsf"
NOT_FOUND = "Sisestatud andmetega sõidukit registris ei ole!"
_FIELDS: dict[str, str] = {"reg_number": "soidukOtsingForm:regMark", "vin": "soidukOtsingForm:vinKood"}
# Cloudflare's page says "Just a moment..." in its title; its body text comes later.
_CLOUDFLARE = re.compile(r"just a moment|checking your browser|verif(?:y|ying) you are human", re.I)
_TRY_LATER = re.compile(r"proovi\w*\s+hiljem|try again later", re.I)
# The site's answer to a search without a usable token: "reCAPTCHA valideerimise viga".
_RECAPTCHA_ERROR = re.compile(r"recaptcha", re.I)
# "Otsin" posts at once and again once getCaptchaToken() has a token. Before api.js
# has loaded, getCaptchaToken() throws and only the tokenless post is sent.
_RECAPTCHA_READY_JS = "() => typeof grecaptcha !== 'undefined' && typeof grecaptcha.execute === 'function'"
_POLL_MS = 250
_OFFSCREEN_PX = 1000  # Google parks a closed challenge frame near -9999 px (captcha.recaptcha)
_FRAMES_JS = """() => Array.from(document.querySelectorAll('iframe'), (f) => {
  const r = f.getBoundingClientRect(), s = getComputedStyle(f);
  return {src: f.getAttribute('src') || '', visible: s.visibility !== 'hidden' && s.display !== 'none',
          x: r.x, y: r.y, width: r.width, height: r.height};
})"""
# Debug screenshots black out the identity: the result header and both search fields.
MASKED_SELECTORS = ("h1", ".content-title p", f'[id="{_FIELDS["reg_number"]}"]', f'[id="{_FIELDS["vin"]}"]')


@dataclass(frozen=True)
class LookupOutcome:
    """A lookup's final result. `pdf` holds the downloaded file when fetched."""

    status: Literal["fetched", "not_found", "unavailable"]
    searched_by: SearchKind | None = None
    reason: BackgroundCheckReason | None = None
    pdf: bytes | None = field(default=None, repr=False)


def _on_screen(box) -> bool:
    return (
        box is not None and box["width"] > 0 and box["height"] > 0
        and box["x"] + box["width"] > -_OFFSCREEN_PX and box["y"] + box["height"] > -_OFFSCREEN_PX
    )


class LookupFailed(Exception):
    """The lookup ended without a result; `reason` is the state's unavailable reason."""

    def __init__(self, reason: BackgroundCheckReason, searched_by: SearchKind | None = None):
        super().__init__(reason)
        self.reason = reason
        self.searched_by = searched_by


@dataclass(frozen=True)
class Limits:
    attempt_s: float = 90  # per browser session, as for the reveal
    cloudflare_s: float = 30  # a Cloudflare page must clear by itself within this
    recaptcha_s: float = 15  # for grecaptcha to load once the search form is shown
    answer_s: float = 30  # after "Otsin", for the result, the refusal or a challenge
    download_s: float = 30
    stall_s: float = 20  # the extension's stall timer
    rounds: int = 3  # challenge rounds without a pass


def _default_opener(**options) -> AbstractContextManager:
    from .browser_chromium import open_chromium_session
    from .guard import MNT
    return open_chromium_session(site=MNT, **options)


def lookup_background_check(
    search_kind: SearchKind, value: str, deadline: float, *,
    keep_profile: Path | None = None,
    opener: Callable[..., AbstractContextManager] | None = None,
    limits: Limits = Limits(),
    debug_dir: Path | None = None,
    on_debug: Callable | None = None,
) -> LookupOutcome:
    """Search by one identity value and download the PDF before `deadline` (time.monotonic()).

    A failed challenge gets one retry in a fresh session (spec decision 7). Raises
    LookupFailed with the state's reason for every other ending.
    """
    attempt = functools.partial(
        _Attempt, opener or _default_opener, search_kind, value, deadline, limits,
        debug=_debugger(debug_dir, on_debug),
    )
    try:
        return attempt(keep_profile=keep_profile).run()
    except LookupFailed as failed:
        if failed.reason != "captcha_failed" or deadline - time.monotonic() < 10:
            raise
        first = failed
    try:
        return attempt(keep_profile=None).run()
    except LookupFailed as failed:
        # The first attempt sent the search even if the retry never got that far.
        failed.searched_by = failed.searched_by or first.searched_by
        raise


def _debugger(directory: Path | None, hook: Callable | None) -> Callable:
    counter = iter(range(1, 1000))

    def debug(event: str, page) -> None:
        try:
            if hook is not None:
                hook(event, page)
            if directory is not None:
                directory.mkdir(parents=True, exist_ok=True)
                page.screenshot(
                    path=str(directory / f"{next(counter):03d}-{event}.png"),
                    mask=[page.locator(selector) for selector in MASKED_SELECTORS],
                    mask_color="#000000",
                )
        except Exception:
            pass  # a debug screenshot never changes the lookup

    return debug


class _Attempt:
    def __init__(self, opener, search_kind, value, deadline, limits, *, debug, keep_profile):
        self.opener = opener
        self.kind = search_kind
        self.value = value
        self.deadline = deadline
        self.end = min(deadline, time.monotonic() + limits.attempt_s)
        self.limits = limits
        self.debug = debug
        self.keep_profile = keep_profile
        self.sent = False

    def fail(self, reason: BackgroundCheckReason) -> LookupFailed:
        return LookupFailed(reason, self.kind if self.sent else None)

    def left_ms(self, until: float | None = None) -> int:
        return max(1, int(((until or self.end) - time.monotonic()) * 1000))

    def out_of_time(self) -> LookupFailed:
        # The attempt's own limit is a page that never answered; the lookup's is a timeout.
        return self.fail("timeout" if time.monotonic() >= self.deadline - 0.5 else "site_changed")

    def run(self) -> LookupOutcome:
        from .browser import CaptureError
        options = {"deadline": self.end}
        if self.keep_profile is not None:
            options["keep_profile"] = self.keep_profile
        try:
            with self.opener(**options) as session:
                return self.drive(session)
        except LookupFailed:
            raise
        except CaptureError as exc:
            raise self.fail("blocked" if exc.code == "access_blocked" else "browser_crash") from None
        except Exception:
            # A Playwright call that ran out the attempt, or the session watchdog's kill.
            if time.monotonic() >= self.end - 0.5:
                raise self.out_of_time() from None
            raise self.fail("browser_crash") from None

    def drive(self, session) -> LookupOutcome:
        page = session.page
        self.open_search(session)
        self.search(page)
        if self.answer(page) == "not_found":
            self.debug("not_found", page)
            return LookupOutcome(status="not_found", searched_by=self.kind)
        self.debug("result", page)
        pdf = self.download(page)
        if not pdf_matches(pdf, self.value):
            raise self.fail("pdf_rejected")
        return LookupOutcome(status="fetched", searched_by=self.kind, pdf=pdf)

    # --- search page --------------------------------------------------------------

    def text(self, page) -> str:
        try:
            return page.locator("body").inner_text(timeout=1000)
        except Exception:
            return ""

    def visible(self, locator) -> bool:
        try:
            return locator.first.is_visible()
        except Exception:
            return False

    def cloudflare(self, page, text: str) -> bool:
        try:
            title = page.title()
        except Exception:
            title = ""
        return bool(_CLOUDFLARE.search(title) or _CLOUDFLARE.search(text))

    def try_later(self, page) -> bool:
        return self.visible(page.locator(".message-error, .ui-messages", has_text=_TRY_LATER))

    def open_search(self, session) -> None:
        page = session.page
        try:
            page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=self.left_ms())
        except Exception:
            if session.main_frame_blocked:
                raise self.fail("blocked") from None
            raise
        cloudflare_until = None
        form_missing_since = None
        fields = [page.locator(f'[id="{name}"]') for name in _FIELDS.values()]
        while True:
            if session.main_frame_blocked:
                raise self.fail("blocked")
            if all(self.visible(f) for f in fields) and self.visible(self.otsin(page)):
                return
            text = self.text(page)
            now = time.monotonic()
            if self.cloudflare(page, text):
                cloudflare_until = cloudflare_until or now + self.limits.cloudflare_s
                if now >= min(cloudflare_until, self.end):
                    self.debug("cloudflare", page)
                    raise self.fail("blocked")
                form_missing_since = None
            elif self.try_later(page):
                raise self.fail("blocked")
            else:
                form_missing_since = form_missing_since or now
                if now - form_missing_since >= 3:
                    self.debug("no_form", page)
                    raise self.fail("site_changed")
            if now >= self.end:
                raise self.out_of_time()
            page.wait_for_timeout(_POLL_MS)

    def otsin(self, page):
        return page.get_by_role("button", name="Otsin", exact=True)

    def search(self, page) -> None:
        for kind, name in _FIELDS.items():
            page.locator(f'[id="{name}"]').fill(self.value if kind == self.kind else "", timeout=self.left_ms())
        self.wait_for_recaptcha(page)
        self.press_otsin(page)

    def wait_for_recaptcha(self, page) -> None:
        until = min(self.end, time.monotonic() + self.limits.recaptcha_s)
        while True:
            try:
                # grecaptcha lives in the page's own world; Patchright evaluates in an
                # isolated one unless told otherwise. The check only reads.
                if page.evaluate(_RECAPTCHA_READY_JS, isolated_context=False):
                    return
            except Exception:
                pass
            if time.monotonic() >= until:
                self.debug("no_recaptcha", page)
                raise self.out_of_time() if until >= self.end else self.fail("captcha_failed")
            page.wait_for_timeout(_POLL_MS)

    def press_otsin(self, page) -> None:
        self.otsin(page).first.click(timeout=self.left_ms())
        self.sent = True

    # --- answer -------------------------------------------------------------------

    def on_result(self, page) -> bool:
        return RESULT_PATH in page.url

    def refused(self, page) -> bool:
        return self.visible(page.locator(".message-error", has_text=NOT_FOUND))

    def token_rejected(self, page) -> bool:
        return self.visible(page.locator(".message-error, .ui-messages", has_text=_RECAPTCHA_ERROR))

    def challenge_frame(self, page):
        return page.locator('iframe[src*="/recaptcha/"][src*="/bframe"]')

    def challenge_shown(self, page) -> bool:
        """reCAPTCHA's challenge frame is shown, as captcha.recaptcha's challenge_visible."""
        try:
            frame = self.challenge_frame(page).last
            if not frame.is_visible():
                return False
            box = frame.bounding_box(timeout=500)
        except Exception:
            return False
        return _on_screen(box)

    def unknown_challenge(self, page) -> bool:
        """A sizeable visible frame that is not reCAPTCHA's badge or challenge.

        One evaluate reads every frame; per-frame locator calls can each wait
        Playwright's default 30 s for a frame a navigation just removed.
        """
        try:
            frames = page.evaluate(_FRAMES_JS) or []
        except Exception:
            return False
        return any(
            "/recaptcha/" not in (frame.get("src") or "") and frame.get("visible")
            and frame.get("width", 0) >= 100 and frame.get("height", 0) >= 100 and _on_screen(frame)
            for frame in frames
        )

    def answer(self, page) -> Literal["result", "not_found"]:
        until = min(self.end, time.monotonic() + self.limits.answer_s)
        cloudflare_until = None
        challenges = 0
        while True:
            if self.cloudflare(page, self.text(page)):
                # A fixed limit from the first sight, wherever the page shows up.
                now = time.monotonic()
                if cloudflare_until is None:
                    cloudflare_until = min(self.end, now + self.limits.cloudflare_s)
                    until = max(until, cloudflare_until)
                if now >= cloudflare_until:
                    self.debug("cloudflare", page)
                    raise self.fail("blocked")
                page.wait_for_timeout(_POLL_MS)
                continue
            if self.on_result(page):
                page.wait_for_load_state("domcontentloaded", timeout=self.left_ms())
                if not self.cloudflare(page, self.text(page)):
                    return "result"
                continue
            if self.refused(page):
                return "not_found"
            if self.try_later(page):
                self.debug("try_again_later", page)
                raise self.fail("blocked")
            if self.challenge_shown(page):
                challenges += 1
                if challenges > self.limits.rounds or not self.watch_challenge(page):
                    self.debug("challenge_failed", page)
                    raise self.fail("captcha_failed")
                if not (self.on_result(page) or self.refused(page)):
                    self.press_otsin(page)  # the site asks for "Otsin" again after a solve
                until = min(self.end, time.monotonic() + self.limits.answer_s)
                continue
            if self.unknown_challenge(page):
                self.debug("unknown_challenge", page)
                raise self.fail("captcha_failed")
            if time.monotonic() >= until:
                # The tokenless post's error shows on every search until the token's
                # answer replaces it, so it counts only once no answer came.
                if self.token_rejected(page):
                    self.debug("token_rejected", page)
                    raise self.fail("captcha_failed")
                self.debug("no_answer", page)
                raise self.out_of_time() if until >= self.end else self.fail("site_changed")
            page.wait_for_timeout(_POLL_MS)

    def watch_challenge(self, page) -> bool:
        from .captcha.extension_wait import watch_extension

        def done() -> bool:
            # A result, a refusal, or the challenge closing after a solve ends the watch.
            return self.on_result(page) or self.refused(page) or not self.challenge_shown(page)

        outcome = watch_extension(
            page, deadline=self.end, rounds_left=self.limits.rounds,
            stall_s=self.limits.stall_s, value_shown=done,
        )
        if not outcome.passed and outcome.reason == "try_again_later":
            self.debug("try_again_later", page)
            raise self.fail("blocked")  # reCAPTCHA's own "try again later", as on Auto24
        if not outcome.passed and outcome.reason == "timeout" and time.monotonic() >= self.deadline - 0.5:
            raise self.fail("timeout")
        return outcome.passed

    # --- download -----------------------------------------------------------------

    def download(self, page) -> bytes:
        save = page.locator("a, button", has_text=re.compile(r"^\s*Salvestan\s*$"))
        try:
            save.first.wait_for(state="visible", timeout=min(self.left_ms(), 5000))
        except Exception:
            self.debug("no_salvestan", page)
            raise self.fail("site_changed") from None
        until = min(self.end, time.monotonic() + self.limits.download_s)
        try:
            with page.expect_download(timeout=self.left_ms(until)) as info:
                save.first.click(timeout=self.left_ms(until))
            download = info.value
            path = download.path()  # no timeout of its own; the session watchdog bounds it
        except Exception:
            if time.monotonic() >= self.end - 0.5:
                raise self.out_of_time() from None
            self.debug("no_download", page)
            raise self.fail("pdf_rejected") from None
        if path is None or download.failure() is not None:
            raise self.fail("pdf_rejected")
        path = Path(path)
        if path.stat().st_size > MAX_PDF_BYTES:
            raise self.fail("pdf_rejected")
        return path.read_bytes()
