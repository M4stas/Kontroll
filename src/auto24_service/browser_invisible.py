"""Helpers for invisible browser sessions."""

import time
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass
class PdfResponse:
    body: bytes | None = None


def recaptcha_badge_shown(page) -> bool:
    return bool(page.evaluate("() => !!document.querySelector('.grecaptcha-badge')"))


@contextmanager
def expect_pdf_response(page, timeout_ms: int):
    result = PdfResponse()
    end = time.monotonic() + timeout_ms / 1000

    def on_response(response):
        if result.body is None:
            try:
                body = response.body()
                if body.startswith(b"%PDF-"):
                    result.body = body
            except Exception:
                pass

    page.on("response", on_response)
    try:
        yield result
        while result.body is None and (remaining := end - time.monotonic()) > 0:
            page.wait_for_timeout(min(100, max(1, int(remaining * 1000))))
    finally:
        page.remove_listener("response", on_response)
