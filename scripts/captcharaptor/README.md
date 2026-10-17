# Local-only CaptchaRaptor build (Plan A)

`build_extension.py` builds an unpacked Chrome extension from CaptchaRaptor/captchaplugin at commit `7462474d5fdfda5618becc9ac7a421de3ea69495`, so it can be benchmarked against the Python solver.

What the build does:

- It checks the tarball's SHA-256 and reads files from it without extracting it. Symlinks and `..` paths stop the build.
- It copies only an allowlist: the content scripts, the ONNX solver, sql.js, onnxruntime-web, the models, the sqlite file, icons and LICENSE. `uploader.js`, `ws/`, `ws-addon/`, `reports.*`, `popup.*` and the upstream `background.js` are never copied.
- It writes a new Manifest V3. Host permissions, content scripts and web-accessible resources are limited to `*://*.google.com/recaptcha/*` and `*://*.recaptcha.net/recaptcha/*`. The only permission is `declarativeNetRequest`, for upstream's rule that loads reCAPTCHA frames in English.
- It replaces the background with `background.js` from this folder. Settings are fixed: auto-open and auto-solve are on, with upstream's delays. pHash lookups use the bundled sqlite file. Solve logs and image collection get an empty reply and nothing is stored.
- It removes the content script's message that told the host page each solving step.
- It fails if the output still contains `uploader`, `upload.php`, `captcharaptor.com`, `captchaplugin.com`, `ws.captcharaptor`, `wss://`, `WebSocket`, `sendBeacon`, `offscreen` (other than `OffscreenCanvas`) or `reporting`, or a URL in code or text outside reCAPTCHA.
- It writes `BUILD-INFO.txt` with the SHA-256 of every output file.

## Build

Download the tarball into an empty folder, then build:

```sh
curl -sSfL -o captchaplugin-7462474.tar.gz \
  https://codeload.github.com/CaptchaRaptor/captchaplugin/tar.gz/7462474d5fdfda5618becc9ac7a421de3ea69495
python3 -I scripts/captcharaptor/build_extension.py captchaplugin-7462474.tar.gz
```

The extension lands in `~/.cache/auto24/captcharaptor-local/7462474d5fdf/`.

## Load

In Chromium, open `chrome://extensions`, turn on Developer mode, choose Load unpacked and pick that folder. Use a separate browser profile for it.

## Tests

```sh
docker run --rm --network none -v "$PWD:/app:ro" -w /app -e PYTHONPATH=/app/src \
  --entrypoint python auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider tests/test_build_extension.py
```
