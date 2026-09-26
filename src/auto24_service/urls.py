"""Validation and canonicalization for public Auto24 listing URLs."""

import re
from urllib.parse import urlsplit


ALLOWED_HOSTS = frozenset(
    {"auto24.ee", "www.auto24.ee", "eng.auto24.ee", "rus.auto24.ee"}
)
LISTING_PATH = re.compile(r"/soidukid/([0-9]+)/?")


class InvalidListingURL(ValueError):
    """Raised when a URL is not a supported public Auto24 listing."""


def canonical_listing_url(raw: str) -> str:
    """Return the canonical www URL for a supported Auto24 listing."""
    try:
        parts = urlsplit(raw)
        hostname = parts.hostname
        port = parts.port
    except (TypeError, ValueError) as exc:
        raise InvalidListingURL(raw) from exc

    match = LISTING_PATH.fullmatch(parts.path)
    if (
        parts.scheme.lower() != "https"
        or hostname not in ALLOWED_HOSTS
        or port is not None
        or parts.netloc.casefold() != hostname
        or parts.username is not None
        or parts.password is not None
        or "#" in raw
        or not match
    ):
        raise InvalidListingURL(raw)

    return f"https://www.auto24.ee/soidukid/{match.group(1)}"
