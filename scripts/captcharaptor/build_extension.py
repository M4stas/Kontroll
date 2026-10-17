#!/usr/bin/env python3
"""Build a local-only CaptchaRaptor extension from the pinned upstream tarball.

The tarball is read, never extracted or run. Only allowlisted files are copied.
The build writes its own Manifest V3 and background script, removes the content
script's message to the host page, and fails if any reporting, upload or remote
control string, or any URL outside reCAPTCHA, is left in the output.

Usage:
  build_extension.py TARBALL ORT_TARBALL [--out DIR]

Download both tarballs once (about 59 MB and 30 MB) into an empty folder:
  curl -sSfL -o captchaplugin-7462474.tar.gz \
    https://codeload.github.com/CaptchaRaptor/captchaplugin/tar.gz/7462474d5fdfda5618becc9ac7a421de3ea69495
  curl -sSfL -o onnxruntime-web-1.22.0.tgz \
    https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.22.0.tgz
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

# Upstream ships onnxruntime-web 1.22.0's dist/ort.all.min.mjs as ort.esm.js with
# its comments removed. The build copies the release file unchanged instead, so
# every onnxruntime-web file is byte-identical to the npm release.
ORT_TARBALL_SHA256 = "e293551f9d36d003e293d0f2937fee7b3dfdcef76d71d1449b55e2d4157c7aea"
ORT_MEMBER = "package/dist/ort.all.min.mjs"
ORT_MEMBER_SHA256 = "abd87226e2b3d80dbe1d4286781b5e949a8e81a0f361425f7b4937a2c599dc2b"
ORT_OUT = "libs/onnxruntime-web/ort.esm.js"

# Upstream paths copied unchanged (relative to the tarball root), each pinned so
# any change in a new upstream commit forces a fresh review. Checked on
# 2026-10-17: sql-wasm.* and the two ort-wasm-simd-threaded.jsep.* files are
# byte-identical to the npm releases sql.js 1.13.0 and onnxruntime-web 1.22.0.
FILE_SHA256 = {
    "LICENSE": "f4e35c9a69151d53cc26d8f9881b08f29dc57a5491ed68a4719ad26981140e7e",
    "extension/eventhook.js": "7aa9b40c2cd87b4061b947719b853fb6e26dcf397262cfb8304356a9bfb61785",
    "extension/eventhook/loader.js": "d405f762873d66e817209458b8359eb5bb405fa8d12cd0bbf22c8c85e54a1968",
    "extension/captcha/recaptcha.js": "afcf576c75b4618fc9b085a0b5a5356df1e01dfeb576882061c2f4495b6ee504",
    "extension/captcha/recaptcha_ai.js": "9324fdca4467c8e37df49783b17151e5a4328398745eb22acdc7d1c28d23b5d3",
    "extension/captcha/phash-browser.js": "10a5678741cb44cad119f2b12184ca1c381e9b6d4b8478a68e4b8a7bc73ac69c",
    "extension/background_sqlite.js": "23c776abccdd692b82effdf3b9bfa9053fb6df7474b8415ed9eef576c1919187",
    "extension/lib/sql-wasm.js": "694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3",
    "extension/lib/sql-wasm.wasm": "0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73",
    "extension/libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs": "1cbcba8f2c769c1eecbab66a1b1e55ef11704515bf4306373e3db3c37cf6dcd8",
    "extension/libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm": "b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368",
    "extension/models/type.onnx": "3d48dc93d0b1fb3e399096eeaa387f0877a939b0ea0a824a703865234c0a6f0b",
    "extension/models/grid.onnx": "19afc4fb06af9a20bc920fd728cf556def069a2af8a7760f919fd825c8369e64",
    "extension/models/grid.meta.json": "d5b788706dca5401564656ab25ccae37898ff4aed96c5b2fb902dd32b4c1df49",
    "extension/db/captcha.sqlite": "7689a67eda67fdf242c6eefd23994325d4982c9b66f40fdaad498a1af9a6da08",
    "extension/icon/16.png": "4c360e262f643f0749e0db856bab204a9daeaa2da0844398c1dd07ac18d7254c",
    "extension/icon/32.png": "e970d298bcd39a24ecda41c77a41b359399f202abb30ee92a34dededb4965453",
    "extension/icon/48.png": "c5ebf464f5f61a7a80d1ede18a89a6a3025cb6b4237225e81966e98690501521",
    "extension/icon/128.png": "a039eb82d4decdb7d0d1e59629ad0eeacffce49bbfe14b6d9cf179c787c6aa75",
}
COPY = tuple(FILE_SHA256)

RECAPTCHA_MATCHES = ["https://www.google.com/recaptcha/*", "https://www.recaptcha.net/recaptcha/*"]
# web_accessible_resources matches take an origin only (path must be /*).
RECAPTCHA_ORIGINS = ["https://www.google.com/*", "https://www.recaptcha.net/*"]

# The content script tells the host page (Auto24) and Google's frame scripts each
# solving step. Nothing in the extension listens for either, so both go. The
# local step counter stays.
STEP_BROADCAST = """  try {
    if (window.top && window.top !== window) {
      window.top.postMessage(
        { type: 'recaptcha:step', detail: { count: window.__recaptchaSteps, ts: Date.now() } },
        '*'
      );
    }
  } catch {}
"""
STEP_EVENT = """  try {
    window.dispatchEvent(new CustomEvent('recaptcha:step', {
      detail: { count: window.__recaptchaSteps, ts: Date.now() }
    }));
  } catch {}
"""
# The MAIN-world loader takes click commands from any frame's postMessage. Only
# the extension's own content script, posting on the same window, may send them.
LOADER_LISTENER = 'typeof d != "object" || d.source !== "captcharaptor"'
LOADER_LISTENER_SAFE = 'm.source !== window || typeof d != "object" || d.source !== "captcharaptor"'

# (output path, exact upstream text, replacement); each must match exactly once.
PATCHES = (
    ("captcha/recaptcha.js", STEP_BROADCAST, ""),
    ("captcha/recaptcha.js", STEP_EVENT, ""),
    ("eventhook/loader.js", LOADER_LISTENER, LOADER_LISTENER_SAFE),
)

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
# Exact URLs allowed in code and text: the reCAPTCHA origins in the manifest and
# the Apache license link in onnxruntime-web's license comments.
ALLOWED_URLS = (*RECAPTCHA_ORIGINS, "http://www.apache.org/licenses/LICENSE-2.0")


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
        # Covers the service worker too: it can load and fetch only its own files.
        "content_security_policy": {"extension_pages":
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none';"},
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
            "matches": RECAPTCHA_ORIGINS,
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


def _read_members(path: Path, pinned: str, wanted: dict[str, str]) -> dict[str, bytes]:
    """Member name -> bytes for the wanted members, read without extracting."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != pinned:
        raise BuildError(f"{path.name}: SHA-256 {digest.hexdigest()} does not match the pinned {pinned}")
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
    missing = sorted(set(wanted.values()) - set(files))
    if missing:
        raise BuildError(f"missing from {path.name}: {', '.join(missing)}")
    return files


def read_tarball(path: Path) -> dict[str, bytes]:
    """The allowlisted upstream files, each checked against its pin."""
    files = _read_members(path, TARBALL_SHA256, {f"{ROOT}/{p}": p for p in COPY})
    changed = sorted(p for p, data in files.items() if sha256(data) != FILE_SHA256[p])
    if changed:
        raise BuildError(f"files differ from the reviewed pins: {', '.join(changed)}")
    return files


def read_ort(path: Path) -> bytes:
    """onnxruntime-web's ort.all.min.mjs from the npm release, checked against its pin."""
    data = _read_members(path, ORT_TARBALL_SHA256, {ORT_MEMBER: ORT_MEMBER})[ORT_MEMBER]
    if sha256(data) != ORT_MEMBER_SHA256:
        raise BuildError(f"{ORT_MEMBER} differs from the reviewed pin")
    return data


def assemble(files: dict[str, bytes], background_js: bytes, ort_js: bytes) -> dict[str, bytes]:
    """Output path -> bytes for the unpacked extension."""
    out = {("LICENSE" if p == "LICENSE" else p.removeprefix("extension/")): data for p, data in files.items()}
    for path, old, new in PATCHES:
        text = out[path].decode("utf-8")
        if text.count(old) != 1:
            raise BuildError(f"{path}: patch target not found exactly once: {old.strip().splitlines()[0]}")
        out[path] = text.replace(old, new).encode("utf-8")
    out[ORT_OUT] = ort_js
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
            if not url.startswith(ALLOWED_URL_PREFIXES) and url.decode("ascii", "replace") not in ALLOWED_URLS:
                problems.append(f"{path}: URL {url.decode('ascii', 'replace')}")
    if problems:
        raise BuildError("output failed the local-only check:\n  " + "\n  ".join(problems))


def write(out: dict[str, bytes], dest: Path) -> None:
    info = [
        f"upstream: CaptchaRaptor/captchaplugin@{UPSTREAM_COMMIT}", f"tarball sha256: {TARBALL_SHA256}",
        f"{ORT_OUT}: onnxruntime-web 1.22.0 {ORT_MEMBER}, tarball sha256: {ORT_TARBALL_SHA256}", "",
    ]
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
            if not (dest / "BUILD-INFO.txt").is_file():
                raise BuildError(f"{dest} exists and is not an earlier build; refusing to replace it")
            shutil.rmtree(dest)
        tmp.rename(dest)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def build(tarball: Path, ort_tarball: Path, dest: Path, background: Path = HERE / "background.js") -> dict[str, bytes]:
    out = assemble(read_tarball(tarball), background.read_bytes(), read_ort(ort_tarball))
    check(out)
    write(out, dest)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tarball", type=Path, help="CaptchaRaptor tarball at the pinned commit")
    parser.add_argument("ort_tarball", type=Path, help="onnxruntime-web 1.22.0 npm tarball")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / UPSTREAM_COMMIT[:12])
    args = parser.parse_args(argv)
    try:
        out = build(args.tarball, args.ort_tarball, args.out)
    except (BuildError, OSError, tarfile.TarError) as exc:
        print(f"build_extension: error: {exc}", file=sys.stderr)
        return 1
    print(f"built {len(out)} files into {args.out}")
    print("load it in Chromium: chrome://extensions, Developer mode, Load unpacked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
