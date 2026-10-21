import os
import re
from pathlib import Path

import pytest

from auto24_service.captcha.assets import PINNED_SOLVER_SHA256, read_sums, sha256_file

SUMS = Path("vendor/captcha-solver/SHA256SUMS")
SOLVER_DIR = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))


def test_sha256sums_lists_exactly_the_four_files():
    entries = read_sums(SUMS)
    assert sorted(entries) == ["captcha.sqlite", "grid.meta.json", "grid.onnx", "type.onnx"]
    assert all(re.fullmatch(r"[0-9a-f]{64}", h) for h in entries.values())


@pytest.mark.skipif(not SOLVER_DIR.exists(), reason="solver files not installed")
def test_installed_solver_files_match_sha256sums():
    for name, expected in read_sums(SUMS).items():
        assert sha256_file(SOLVER_DIR / name) == expected


def test_pinned_constant_equals_vendor_sha256sums():
    assert dict(PINNED_SOLVER_SHA256) == read_sums(SUMS)
