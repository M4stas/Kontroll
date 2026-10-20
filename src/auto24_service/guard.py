"""Per-site request policy shared by browser engines."""

from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class SiteAllowlist:
    main_frame_hosts: frozenset[str]
    subresource_hosts: frozenset[str]
    subresource_prefixes: tuple[str, ...]


ALLOWED_SUBRESOURCE_HOSTS = frozenset({"www.auto24.ee"})
ALLOWED_SUBRESOURCE_PREFIXES = (
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
)
AUTO24 = SiteAllowlist(
    main_frame_hosts=frozenset({"www.auto24.ee"}),
    subresource_hosts=ALLOWED_SUBRESOURCE_HOSTS,
    subresource_prefixes=ALLOWED_SUBRESOURCE_PREFIXES,
)
# Prefix paths reject traversal and all percent escapes, including double encoding.
_UNSAFE_PATH_PARTS = ("..", "%", "\\")


def allowed_url(
    url: str,
    *,
    main_frame: bool,
    site: SiteAllowlist = AUTO24,
    extension_id: str | None = None,
) -> bool:
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except (TypeError, ValueError):
        return False
    if (
        host is None
        or port is not None
        or parts.username is not None
        or parts.password is not None
        or parts.netloc.casefold() != host
    ):
        return False
    if parts.scheme == "chrome-extension":
        return (
            not main_frame
            and extension_id is not None
            and parts.netloc == extension_id
            and not any(part in parts.path for part in _UNSAFE_PATH_PARTS)
        )
    if parts.scheme != "https":
        return False
    if main_frame:
        return host in site.main_frame_hosts
    if host in site.subresource_hosts:
        return True
    path = parts.path.casefold()
    if any(part in path for part in _UNSAFE_PATH_PARTS):
        return False
    return url.startswith(site.subresource_prefixes)


def blocked_entry(url: str) -> str:
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
    except (TypeError, ValueError):
        return "invalid/"
    segment = parts.path.lstrip("/").split("/", 1)[0]
    return f"{host}/{segment}/" if segment else f"{host}/"

