#!/usr/bin/env python3
"""Build a local-only CaptchaRaptor extension from the pinned upstream tarball.

The tarball is read, never extracted or run. Only allowlisted files are copied.
The build writes its own Manifest V3 and background script, removes the content
script's message to the host page, and fails if any reporting, upload or remote
control string, or any URL outside reCAPTCHA, is left in the output.

Usage:
  build_extension.py TARBALL [--out DIR]

Download the tarball once (about 59 MB) into an empty folder:
  curl -sSfL -o captchaplugin-7462474.tar.gz \
    https://codeload.github.com/CaptchaRaptor/captchaplugin/tar.gz/7462474d5fdfda5618becc9ac7a421de3ea69495
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

UPSTREAM_COMMIT = "7462474d5fdfda5618becc9ac7a421de3ea69495"
TARBALL_SHA256 = "b778bfbebcbc722a0fc975753ef836a7e9be394aaa6cb1a2e911a0e9bcd3f9eb"
ROOT = f"captchaplugin-{UPSTREAM_COMMIT}"
HERE = Path(__file__).resolve().parent
DEFAULT_OUT = Path.home() / ".cache" / "auto24" / "captcharaptor-local"

# Upstream paths copied unchanged (relative to the tarball root).
COPY = (
    "LICENSE",
    "extension/eventhook.js",
    "extension/eventhook/loader.js",
    "extension/captcha/recaptcha.js",
    "extension/captcha/recaptcha_ai.js",
    "extension/captcha/phash-browser.js",
    "extension/background_sqlite.js",
    "extension/lib/sql-wasm.js",
    "extension/lib/sql-wasm.wasm",
    "extension/libs/onnxruntime-web/ort.esm.js",
    "extension/libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs",
    "extension/libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm",
    "extension/models/type.onnx",
    "extension/models/grid.onnx",
    "extension/models/grid.meta.json",
    "extension/db/captcha.sqlite",
    "extension/icon/16.png",
    "extension/icon/32.png",
    "extension/icon/48.png",
    "extension/icon/128.png",
)

RECAPTCHA_MATCHES = ["*://*.google.com/recaptcha/*", "*://*.recaptcha.net/recaptcha/*"]

# The content script tells the host page (Auto24) each solving step. Nothing in
# the extension listens for it, so it goes. The local step counter stays.
STEP_BROADCAST = """  try {
    if (window.top && window.top !== window) {
      window.top.postMessage(
        { type: 'recaptcha:step', detail: { count: window.__recaptchaSteps, ts: Date.now() } },
        '*'
      );
    }
  } catch {}
"""

BANNED = (
    "uploader", "upload.php", "captcharaptor.com", "captchaplugin.com", "ws.captcharaptor",
    "wss://", "websocket", "sendbeacon", "offscreen", "reporting",
)
# Chrome's offscreen documents held upstream's WebSocket. OffscreenCanvas is a
# local drawing API that the solver and onnxruntime-web use (onnxruntime-web
# also has the error text "offscreen canvas"), so those two are allowed.
OFFSCREEN_OK = (b"offscreencanvas", b"offscreen canvas")
# URLs are checked in code and text only. Binary files (images, wasm, models,
# sqlite) hold documentation and metadata strings that nothing fetches.
TEXT_SUFFIXES = (".js", ".mjs", ".json", ".html", ".txt")
URL = re.compile(rb"(?:https?|wss?)://[^\s\"'`<>)\\]+", re.IGNORECASE)
ALLOWED_URL_PREFIXES = (
    b"https://www.google.com/recaptcha/",
    b"https://www.recaptcha.net/recaptcha/",
    # Comments inside the bundled sql.js and onnxruntime-web builds.
    b"https://github.com/kripken/emscripten/issues/5820",
    b"https://web.dev/cross-origin-isolation-guide/",
)


class BuildError(Exception):
    pass


def manifest() -> dict:
    return {
        "manifest_version": 3,
        "name": "CaptchaRaptor local (benchmark build)",
        "version": "0.2.30",
        "description": f"Local-only build of CaptchaRaptor {UPSTREAM_COMMIT[:7]} for benchmarks. Solves on this device only.",
        "minimum_chrome_version": "111",
        "icons": {n: f"icon/{n}.png" for n in ("16", "32", "48", "128")},
        "permissions": ["declarativeNetRequest"],
        "host_permissions": RECAPTCHA_MATCHES,
        "background": {"service_worker": "background.js"},
        "content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"},
        "declarative_net_request": {
            "rule_resources": [{"id": "hl_en", "enabled": True, "path": "rules/hl_en.json"}],
        },
        "content_scripts": [
            {"matches": RECAPTCHA_MATCHES, "js": ["eventhook/loader.js"], "run_at": "document_start",
             "all_frames": True, "world": "MAIN"},
            {"matches": RECAPTCHA_MATCHES, "js": ["eventhook.js", "captcha/recaptcha.js"],
             "run_at": "document_start", "all_frames": True},
        ],
        "web_accessible_resources": [{
            "resources": [
                "models/type.onnx", "models/grid.onnx", "models/grid.meta.json",
                "captcha/phash-browser.js", "captcha/recaptcha_ai.js", "libs/onnxruntime-web/*",
            ],
            "matches": RECAPTCHA_MATCHES,
        }],
    }


# Upstream sets this rule at runtime: reCAPTCHA frames load in English, which the
# upstream solver needs to read the instruction text.
HL_EN_RULES = [{
    "id": 1,
    "priority": 1,
    "action": {"type": "redirect", "redirect": {"transform": {"queryTransform": {
        "addOrReplaceParams": [{"key": "hl", "value": "en"}]}}}},
    "condition": {"regexFilter": r"^https?://[^\.]*\.(google\.com|recaptcha\.net)/recaptcha",
                  "resourceTypes": ["sub_frame"]},
}]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_tarball(path: Path) -> dict[str, bytes]:
    """The allowlisted files, read from the tarball without extracting it."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != TARBALL_SHA256:
        raise BuildError(f"tarball SHA-256 {digest.hexdigest()} does not match the pinned {TARBALL_SHA256}")
    wanted = {f"{ROOT}/{p}": p for p in COPY}
    files: dict[str, bytes] = {}
    with tarfile.open(path, "r:gz") as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts:
                raise BuildError(f"unsafe path in tarball: {member.name}")
            if not (member.isfile() or member.isdir()) and member.name != "pax_global_header":
                raise BuildError(f"link or special file in tarball: {member.name}")
            if member.name in wanted:
                fh = tar.extractfile(member)
                assert fh is not None
                files[wanted[member.name]] = fh.read()
    missing = sorted(set(COPY) - set(files))
    if missing:
        raise BuildError(f"missing from tarball: {', '.join(missing)}")
    return files


def assemble(files: dict[str, bytes], background_js: bytes) -> dict[str, bytes]:
    """Output path -> bytes for the unpacked extension."""
    out = {("LICENSE" if p == "LICENSE" else p.removeprefix("extension/")): data for p, data in files.items()}
    script = out["captcha/recaptcha.js"].decode("utf-8")
    if script.count(STEP_BROADCAST) != 1:
        raise BuildError("recaptcha.js: the step broadcast to the host page was not found exactly once")
    out["captcha/recaptcha.js"] = script.replace(STEP_BROADCAST, "").encode("utf-8")
    out["background.js"] = background_js
    out["manifest.json"] = (json.dumps(manifest(), indent=2) + "\n").encode()
    out["rules/hl_en.json"] = (json.dumps(HL_EN_RULES, indent=2) + "\n").encode()
    return out


def check(out: dict[str, bytes]) -> None:
    """Fail closed on reporting, upload or remote-control code and foreign URLs."""
    problems = []
    for path, data in sorted(out.items()):
        if path == "LICENSE":
            continue
        lower = data.lower()
        for word in BANNED:
            hay = lower
            if word == "offscreen":
                for ok in OFFSCREEN_OK:
                    hay = hay.replace(ok, b"")
            if word.encode() in hay:
                problems.append(f"{path}: contains {word!r}")
        if not path.endswith(TEXT_SUFFIXES):
            continue
        for url in URL.findall(data):
            if not url.startswith(ALLOWED_URL_PREFIXES):
                problems.append(f"{path}: URL {url.decode('ascii', 'replace')}")
    if problems:
        raise BuildError("output failed the local-only check:\n  " + "\n  ".join(problems))


def write(out: dict[str, bytes], dest: Path) -> None:
    info = [f"upstream: CaptchaRaptor/captchaplugin@{UPSTREAM_COMMIT}", f"tarball sha256: {TARBALL_SHA256}", ""]
    info += [f"{sha256(data)}  {path}" for path, data in sorted(out.items())]
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".build-", dir=dest.parent))
    try:
        for path, data in out.items():
            target = tmp / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (tmp / "BUILD-INFO.txt").write_text("\n".join(info) + "\n")
        if dest.exists():
            shutil.rmtree(dest)
        tmp.rename(dest)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def build(tarball: Path, dest: Path, background: Path = HERE / "background.js") -> dict[str, bytes]:
    out = assemble(read_tarball(tarball), background.read_bytes())
    check(out)
    write(out, dest)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tarball", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / UPSTREAM_COMMIT[:12])
    args = parser.parse_args(argv)
    try:
        out = build(args.tarball, args.out)
    except (BuildError, OSError, tarfile.TarError) as exc:
        print(f"build_extension: error: {exc}", file=sys.stderr)
        return 1
    print(f"built {len(out)} files into {args.out}")
    print("load it in Chromium: chrome://extensions, Developer mode, Load unpacked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
