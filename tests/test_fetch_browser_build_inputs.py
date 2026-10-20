import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/fetch-browser-build-inputs"


def setup_inputs(tmp_path, *, digest=None, second=False):
    source = tmp_path / "source"
    source.mkdir()
    payload = b"offline fixture wheel"
    (source / "first.whl").write_bytes(payload)
    item = dict(filename="first.whl", url="https://invalid.test/first.whl", size=len(payload),
                sha256=digest or hashlib.sha256(payload).hexdigest(), cache_path="wheels/arm64/first.whl")
    records = {"arm64": [item]}
    if second:
        records["amd64"] = [dict(item, filename="second.whl", cache_path="wheels/amd64/second.whl")]
    manifests = tmp_path / "manifests"
    manifests.mkdir()
    (manifests / "python-inputs.json").write_text(json.dumps({"platforms": records}))
    (manifests / "debian-inputs.json").write_text(json.dumps({"packages": []}))
    return source, manifests, tmp_path / "home/.cache/auto24/browser-assets"


def run_fetch(tmp_path, source, manifests):
    return subprocess.run([sys.executable, str(SCRIPT), "--manifests", str(manifests),
                           "--source-dir", str(source)], env={**os.environ, "HOME": str(tmp_path / "home")},
                          capture_output=True, text=True)


def test_fetch_build_inputs_rejects_hash_without_publication(tmp_path):
    source, manifests, cache = setup_inputs(tmp_path, digest="0" * 64)
    result = run_fetch(tmp_path, source, manifests)
    assert result.returncode != 0
    assert "SHA256" in result.stderr
    assert not list(cache.rglob("*.whl"))
    assert not list(cache.rglob("*.part"))


def test_fetch_build_inputs_missing_local_input_fails_without_publication(tmp_path):
    source, manifests, cache = setup_inputs(tmp_path)
    (source / "first.whl").unlink()
    result = run_fetch(tmp_path, source, manifests)
    assert result.returncode != 0
    assert "missing local input" in result.stderr
    assert not list(cache.rglob("*.whl"))


def test_fetch_build_inputs_reuses_verified_cache(tmp_path):
    source, manifests, cache = setup_inputs(tmp_path)
    target = cache / "wheels/arm64/first.whl"
    target.parent.mkdir(parents=True)
    target.write_bytes((source / "first.whl").read_bytes())
    (source / "first.whl").unlink()
    result = run_fetch(tmp_path, source, manifests)
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == b"offline fixture wheel"


def test_fetch_build_inputs_materializes_both_architectures_from_same_hash(tmp_path):
    source, manifests, cache = setup_inputs(tmp_path, second=True)
    result = run_fetch(tmp_path, source, manifests)
    assert result.returncode == 0, result.stderr
    assert (cache / "wheels/amd64/second.whl").read_bytes() == (source / "first.whl").read_bytes()
    assert (cache / "wheels/arm64/first.whl").exists()


def test_fetch_build_inputs_reads_debian_manifest(tmp_path):
    source, manifests, cache = setup_inputs(tmp_path)
    payload = b"offline Debian fixture"
    (source / "library.deb").write_bytes(payload)
    record = dict(filename="library.deb", url="https://invalid.test/library.deb", size=len(payload),
                  sha256=hashlib.sha256(payload).hexdigest(), cache_path="debs/arm64/library.deb")
    (manifests / "debian-inputs.json").write_text(json.dumps({"packages": [record]}))
    result = run_fetch(tmp_path, source, manifests)
    assert result.returncode == 0, result.stderr
    assert (cache / "debs/arm64/library.deb").read_bytes() == payload
