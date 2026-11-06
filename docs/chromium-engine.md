# Chromium engine setup

## Chromium engine

`CAPTURE_ENGINE=chromium`, the Compose default, runs ungoogled-chromium with Patchright and a local CaptchaRaptor extension. The reveal waits for the extension and stops after 20 s without progress. The [Chromium engine spec](superpowers/specs/2026-10-19-chromium-extension-engine-design.md) has the design.

Build the image with `linux/arm64`, or `linux/amd64` on an x86_64 server:

```sh
scripts/fetch-browser-assets
scripts/fetch-browser-build-inputs
docker buildx build -f Dockerfile.chromium --platform linux/arm64 \
  --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
  --load -t auto24-extraction-service:chromium .
```

Run `worker-auto24` or `worker-camoufox`, not both:

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 \
  up -d storage api worker-auto24 worker-mnt
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 \
  --profile camoufox up -d storage api worker-camoufox
```

Add `--engine chromium` to the sandbox:

```sh
scripts/network-sandbox offline --engine chromium
scripts/network-sandbox live --engine chromium --url https://www.auto24.ee/soidukid/<listing id>
```

The worker uses a fresh profile per job. `CHROMIUM_WARM_PROFILE=true` keeps one, and logs show `profile_jobs=<n>` and `profile_reset reason=<reason>`. It resets after a blocked capture, a launch failure, a failed reveal, two temporary failures in a row, 30 jobs, 10 hours or a worker restart. The [S3 C evidence](superpowers/checkpoints/2026-10-22-s3-c-warm-profile.md) records why fresh is the default.

WebSockets are blocked. A guard extension in `src/auto24_service/websocket_guard/` loads per session, and the launch fails unless a loopback canary is refused.

### Python tests

Chromium subset on the x86_64 server (offline, no pull):

```sh
docker buildx build -f Dockerfile.chromium --target test --platform linux/amd64 \
  --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
  --load -t auto24-extraction-service:chromium-test .
docker run --rm --platform linux/amd64 --network none --pull=never -v "$PWD:/app:ro" -w /app \
  -e PYTHONPATH=/app/src:/app -e PYTHONDONTWRITEBYTECODE=1 auto24-extraction-service:chromium-test \
  python -m pytest -q -p no:cacheprovider tests/test_browser_chromium.py \
  tests/test_patchright_redirect_patch.py tests/test_extension_wait.py tests/test_real_extension_smoke.py
```

Whole suite, in the sandbox image:

```sh
docker run --rm --network none --pull=never -v "$PWD:/app:ro" -w /app \
  -e PYTHONPATH=/app/src:/app -e PYTHONDONTWRITEBYTECODE=1 --entrypoint python \
  auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider -n 3
```

Do not go above `-n 3`: from four workers up, the CAPTCHA and reveal tests hit their time limits. A full run takes about 5 minutes. Rebuild the sandbox image after changing the test packages in `compose.sandbox.yaml`.

### CI and driver pull requests

[CI](../.github/workflows/ci.yml) runs on pull requests and pushes to `main`. Superseded pull-request runs are cancelled; `main` runs are not cancelled.

For docs-only pull requests, the `check` and `python` jobs still report success but skip dependency setup and checks. [The docs-only detector](../scripts/ci-docs-only) owns the path rules. If detection fails, all steps run.

When checks run, the `python` job runs pytest with `-n auto -m "not browser"`. Tests marked `browser` need the image runs above.

The [Live check workflow](../.github/workflows/live-check.yml) guards the driver paths listed in [scripts/live-check-gate](../scripts/live-check-gate). A PR touching them needs a filled line in its body, or the owner's `live-verified` label:

```text
Live check: <listing or plate class, what ran, result>
```

Empty lines and placeholders such as `pending` or `N/A` do not pass.

### Updating Chromium

Bump Chromium and Patchright together at least monthly, and soon after any Chromium security release. Update the hash pins in `vendor/browser-assets/` and `scripts/fetch-browser-assets`. Merge only when these pass: `scripts/fetch-browser-assets`, the real-extension smoke test on both architectures, the Chromium tests and `scripts/network-sandbox offline --engine chromium`.
