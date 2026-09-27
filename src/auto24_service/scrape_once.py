"""One-link command line scraper for a public Auto24 passenger-car listing."""

import json
import sys
from datetime import datetime, timezone
from typing import Callable, Sequence

from auto24_service.browser import CaptureError, capture_html
from auto24_service.parser import ParseError, parse_listing
from auto24_service.urls import InvalidListingURL, canonical_listing_url


class ScrapeError(RuntimeError):
    """A stable error suitable for the one-link JSON command line interface."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


def scrape_once(
    raw_url: str, *, capture: Callable[[str], str] | None = None
) -> dict:
    """Capture and parse one listing, returning its JSON-compatible result."""
    try:
        url = canonical_listing_url(raw_url)
    except InvalidListingURL as exc:
        raise ScrapeError("access_blocked", "invalid listing URL") from exc
    try:
        html = (capture or capture_html)(url)
    except ScrapeError:
        raise
    except CaptureError as exc:
        raise ScrapeError(exc.code) from exc
    except Exception as exc:
        raise ScrapeError("temporary_failure") from exc
    try:
        listing, warnings = parse_listing(html, url)
    except ParseError as exc:
        raise ScrapeError(exc.code) from exc
    except Exception as exc:
        raise ScrapeError("parse_failed") from exc
    parsed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {**listing.model_dump(mode="json"), "parsed_at": parsed_at, "warnings": warnings}


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        error = ScrapeError("parse_failed", "expected one listing URL")
    else:
        try:
            result = scrape_once(arguments[0])
        except ScrapeError as exc:
            error = exc
        else:
            print(json.dumps(result, ensure_ascii=False))
            return 0
    print(
        json.dumps({"error": {"code": error.code, "message": str(error)}}, ensure_ascii=False),
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
