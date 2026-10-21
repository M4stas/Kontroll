"""Deterministic driver patch and fail-closed Chromium compatibility checks."""
import hashlib
import json
from pathlib import Path

import pytest

from auto24_service import patchright_guard as guard


@pytest.fixture
def driver(tmp_path, monkeypatch):
    bundle = tmp_path / 'lib/coreBundle.js'
    bundle.parent.mkdir()
    original = b'prefix\n' + guard.ORIGINAL_BRANCH + b'\nsuffix\n'
    patched = original.replace(guard.ORIGINAL_BRANCH, guard.PATCHED_BRANCH)
    bundle.write_bytes(original)
    (tmp_path / 'package.json').write_text(json.dumps({'version': '1.63.0'}))
    monkeypatch.setattr(guard, 'ORIGINAL_SHA256', hashlib.sha256(original).hexdigest())
    monkeypatch.setattr(guard, 'PATCHED_SHA256', hashlib.sha256(patched).hexdigest())
    return bundle, original, patched


def test_patch_accepts_exact_original_and_is_idempotent(driver):
    bundle, _, patched = driver
    guard.patch_driver(bundle)
    assert bundle.read_bytes() == patched
    guard.verify_driver(bundle)
    guard.patch_driver(bundle)
    assert bundle.read_bytes() == patched


@pytest.mark.parametrize('contents', [b'unknown', guard.ORIGINAL_BRANCH * 2, b''])
def test_patch_rejects_unknown_input_without_writing(driver, contents):
    bundle, _, _ = driver
    bundle.write_bytes(contents)
    with pytest.raises(ValueError):
        guard.patch_driver(bundle)
    assert bundle.read_bytes() == contents


def test_patch_checks_occurrence_even_when_hash_matches(driver, monkeypatch):
    bundle, _, _ = driver
    contents = guard.ORIGINAL_BRANCH * 2
    bundle.write_bytes(contents)
    monkeypatch.setattr(guard, 'ORIGINAL_SHA256', hashlib.sha256(contents).hexdigest())
    with pytest.raises(ValueError):
        guard.patch_driver(bundle)
    assert bundle.read_bytes() == contents


def test_patch_verifies_output_before_writing(driver, monkeypatch):
    bundle, original, _ = driver
    monkeypatch.setattr(guard, 'PATCHED_SHA256', '0' * 64)
    with pytest.raises(ValueError):
        guard.patch_driver(bundle)
    assert bundle.read_bytes() == original


@pytest.mark.parametrize('version', ['1.64.0', '1.63.1', None])
def test_patch_and_runtime_reject_other_versions(driver, version):
    bundle, original, _ = driver
    (bundle.parent.parent / 'package.json').write_text(json.dumps({'version': version}))
    for check in (guard.patch_driver, guard.verify_driver):
        with pytest.raises(ValueError):
            check(bundle)
    assert bundle.read_bytes() == original


@pytest.mark.parametrize('patched', [False, True])
def test_runtime_accepts_only_exact_patched_driver(driver, patched):
    bundle, _, output = driver
    if patched:
        bundle.write_bytes(output)
        guard.verify_driver(bundle)
        bundle.write_bytes(output + b'changed')
    with pytest.raises(ValueError):
        guard.verify_driver(bundle)


def test_launcher_rejects_unpatched_driver_before_starting_processes(driver, monkeypatch, tmp_path):
    from auto24_service import browser_chromium
    from auto24_service.browser import CaptureError
    bundle, _, _ = driver
    monkeypatch.setattr(browser_chromium, 'verify_driver', lambda: guard.verify_driver(bundle))
    monkeypatch.setattr(browser_chromium.subprocess, 'Popen', lambda *a, **kw: pytest.fail('launched process'))
    with pytest.raises(CaptureError, match='browser_launch'):
        with browser_chromium.open_chromium_listing('https://www.auto24.ee/soidukid/1234567', profile_dir=tmp_path):
            pytest.fail('launched session')
    assert list(tmp_path.glob('a24-chromium-*')) == []
