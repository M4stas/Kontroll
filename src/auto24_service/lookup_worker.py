"""Process only background checks using the invisible browser engine."""

from __future__ import annotations

import argparse
import functools
import logging
import os
import time
from collections.abc import Sequence
from pathlib import Path

from .background_check_runner import DEFAULT_BACKGROUND_CHECK_DIR, run_background_check
from .browser_invisible import open_invisible_session
from .guard import MNT
from .mnt_lookup import lookup_background_check
from .storage_client import StorageClient


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process MNT background checks")
    parser.add_argument("--once", action="store_true", help="process one eligible lookup and exit")
    arguments = parser.parse_args(argv)
    storage_url = os.environ.get("STORAGE_URL", "")
    internal_key = os.environ.get("INTERNAL_API_KEY", "")
    if not storage_url or not internal_key:
        parser.error("STORAGE_URL and INTERNAL_API_KEY must be set")
    directory = Path(os.environ.get("BACKGROUND_CHECK_DIR", str(DEFAULT_BACKGROUND_CHECK_DIR)))
    lookup = functools.partial(
        lookup_background_check, opener=functools.partial(open_invisible_session, site=MNT)
    )
    logging.basicConfig(level=logging.INFO)
    with StorageClient(storage_url, internal_key) as client:
        while True:
            claimed = run_background_check(client, lookup, directory, engine="invisible")
            if arguments.once:
                return 0
            if not claimed:
                time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())
