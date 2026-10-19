"""Offline contract for fetching the four pinned browser inputs."""
import hashlib
import os
from pathlib import Path
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/fetch-browser-assets"
NAMES = (
    "ungoogled-chromium-155.0.8059.84-1-x86_64_linux.tar.xz",
    "ungoogled-chromium-155.0.8059.84-1-arm64_linux.tar.xz",
    "captchaplugin-7462474.tar.gz",
    "onnxruntime-web-1.22.0.tgz",
)


@pytest.fixture
def assets(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    lines = []
    for name in NAMES:
        payload = f"fixture {name}\n".encode()
        (source / name).write_bytes(payload)
        lines.append(f"{hashlib.sha256(payload).hexdigest()}  {name}\n")
    sums = tmp_path / "SHA256SUMS"
    sums.write_text("".join(lines))
    env = {**os.environ, "HOME": str(tmp_path), "BROWSER_ASSETS_SOURCE_DIR": str(source), "BROWSER_ASSETS_SUMS": str(sums)}
    return source, tmp_path / ".cache/auto24/browser-assets", env


def run_fetch(env):
    return subprocess.run(["bash", str(SCRIPT)], env=env, text=True, capture_output=True)


def test_copies_and_verifies_each_input(assets):
    source, cache, env = assets
    result = run_fetch(env)
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("verified:") == 4
    for name in NAMES:
        assert (cache / name).read_bytes() == (source / name).read_bytes()


def test_cached_verified_files_are_not_copied_again(assets):
    source, cache, env = assets
    assert run_fetch(env).returncode == 0
    mtimes = {name: (cache / name).stat().st_mtime_ns for name in NAMES}
    for name in NAMES:
        (source / name).unlink()
    result = run_fetch(env)
    assert result.returncode == 0, result.stderr
    assert {name: (cache / name).stat().st_mtime_ns for name in NAMES} == mtimes


def test_wrong_file_fails_and_leaves_nothing(assets):
    source, cache, env = assets
    (source / NAMES[0]).write_text("changed")
    result = run_fetch(env)
    assert result.returncode == 1
    assert "does not match SHA256SUMS" in result.stderr
    assert not (cache / NAMES[0]).exists()
    assert not list(cache.iterdir())


def test_missing_file_fails(assets):
    source, _, env = assets
    (source / NAMES[0]).unlink()
    result = run_fetch(env)
    assert result.returncode == 1
    assert NAMES[0] in result.stderr
