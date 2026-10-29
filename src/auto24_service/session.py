"""Browser-independent session types."""

from dataclasses import dataclass, field
from typing import Any, Literal


class CaptureError(RuntimeError):
    """A stable browser failure that maps to a listing error code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass
class ListingSession:
    page: Any
    context: Any
    blocked: list[str] = field(default_factory=list)
    main_frame_blocked: bool = False
    extension_loaded: bool | None = None
    engine: Literal["camoufox", "chromium", "invisible"] = "chromium"
