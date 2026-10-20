# Service checkpoint S2: Chromium capture engine

Status: C1 and C2 are built and pass the offline checks on ARM64. Your checks are still open: C1 steps 3 and 4, and every C2 step. The agents ran no live capture, live sandbox or benchmark.

Authority: [service roadmap](../service-roadmap.md), [spec](../specs/2026-10-19-chromium-extension-engine-design.md), [plan](../plans/2026-10-19-chromium-extension-engine.md).

## What was built

A second capture engine runs ungoogled-chromium 155.0.8059.84 with Patchright 1.63.0 and a local build of the CaptchaRaptor extension. `CAPTURE_ENGINE=chromium` selects it and Camoufox stays the default. Pinned inputs are fetched and hash-checked by `scripts/fetch-browser-assets`, and `Dockerfile.chromium` assembles the image with no network during its install steps. The request guard is a per-site allowlist shared by both engines: Auto24, plus the reCAPTCHA paths on Google and Gstatic.

- Redirects are guarded before network contact.
- WebSockets are blocked by a local rule-only guard extension (`src/auto24_service/websocket_guard/`), copied per session. Before the first navigation a loopback canary must be refused, otherwise the launch fails closed (commit `3d4356e`).
- Reveal on Chromium watches the extension solve (`captcha/extension_wait.py`, `solver: extension`). It stops after 20 s without progress, and the value appearing ends the wait.
- `scripts/sandbox-live-capture.py` reveals with the extension on Chromium, so your live sandbox run attempts a solve.
- The benchmark takes `--engine camoufox|chromium|both` and `--mode fresh saved shared` (`both` means `fresh saved`). Results are keyed `<engine>/<mode>`. Only `*/fresh` decides the exit code, and a capture error counts as a failed reveal. `chromium/saved` equals `chromium/fresh` (the report says so). `shared` runs each listing in a new page of one session, so a reveal retry reuses that session's browser context. If the shared session fails to launch, each listing is recorded as a capture error.

## Verification

All counts are from the final commit before this doc, run offline on ARM64.

| Check | Result | Log |
|---|---|---|
| Full suite, sandbox image, `--network none` | 552 passed, 3 skipped in 18 min 13 s | `.superpowers/sdd/2026-10-19-chromium-extension-engine/logs/task-10-full-sandbox.txt` |
| Chromium subset, Chromium test image, ARM64 | 76 passed, 1 failed (load flake), then the failed test passed on its own rerun: 77 of 77 | `logs/task-10-chromium.txt`, `logs/task-10-chromium-rerun.txt` |
| Offline sandbox, `--engine chromium` | PASS, contacted hosts none. Report `sandbox-reports/offline-20261020T111408Z` | `logs/task-10-sandbox-offline.txt` |
| amd64 | Deferred by the user. Run on the x86_64 server during C2 checks. | none |

The flaky test is `test_readiness_never_waits_past_the_deadline`. It asserts a 2 s bound and can exceed it under machine load, here while the full suite ran in parallel. It also failed on the C1 launcher at 09e7835 (controller run, 3 of 3 failed at 1.87 to 2.16 s).

The Chromium subset covers `tests/test_browser_chromium.py`, `tests/test_patchright_redirect_patch.py`, `tests/test_extension_wait.py` and `tests/test_real_extension_smoke.py`, which loads the real extension in the real browser.

## Known gaps

- `--engine both` cannot run in either image. The Chromium image has the Camoufox Python package but neither the Camoufox browser nor the solver files, and the `worker` image has no Patchright. Ruling: C2 step 2 is done as two runs on the same listings file, one per image. Each engine's gate is computed independently, and the two summaries stand in for the side-by-side summary. The commands are in [local development](../../local-development.md#benchmark).
- amd64 evidence is missing, as above.
- The benchmark and reveal on Chromium have only run against fake pages. No live Chromium reveal has run.

## C1: Auto24 capture on Chromium

### What you will see

With `CAPTURE_ENGINE=chromium`, a job submitted on the API docs page completes with the same listing data as a Camoufox capture. Its diagnostics show `engine: chromium` and `extension_loaded: true`. In C1 alone no reveal ran; with C2 built the same job also reveals.

### How to check

1. Run `scripts/fetch-browser-assets` and `scripts/fetch-browser-build-inputs`. Confirm `verified:` for all four browser inputs. Everything is already cached on this machine. If something is missing, review its pinned download entry before authorizing a download.
2. Build the Chromium image and run the offline sandbox on it. Confirm PASS and `contacted hosts: none`. The sandbox never builds or pulls the netlog and reporter images, so they must be cached.

   ```sh
   docker buildx build -f Dockerfile.chromium \
     --platform linux/arm64 --network none --pull=false \
     --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
     --load -t auto24-extraction-service:chromium .
   scripts/network-sandbox offline --engine chromium
   ```

   On the x86_64 server use `--platform linux/amd64`.
3. Run the live sandbox on one listing. Confirm PASS with only `www.auto24.ee`, `www.google.com` and `www.gstatic.com`. Do not paste registration numbers or VINs into the conversation or logs.

   ```sh
   printf 'Listing URL: '
   read -r LISTING_URL
   scripts/network-sandbox live --engine chromium --url "$LISTING_URL"
   ```

   Because C2 is built, this run attempts a solve with the extension.
4. Start the stack with `CAPTURE_ENGINE=chromium` and submit a listing. Compare its facts with a Camoufox capture of the same listing.

   ```sh
   ENV_FILE="$HOME/.config/auto24/auto24.env"
   docker compose --env-file "$ENV_FILE" -p auto24 stop worker
   docker compose --env-file "$ENV_FILE" -p auto24 --profile chromium \
     up -d --no-build --pull never storage api worker-chromium
   ```

   `worker-chromium` sets `CAPTURE_ENGINE=chromium`. Open `http://localhost:8000/docs`, authorize with your API key, submit the listing with `POST /v1/jobs`, then poll `GET /v1/jobs/{job_id}`. Check the facts and the diagnostics. Do not run both workers together.

   To compare with Camoufox, stop `worker-chromium`, start `worker` again and submit the same listing:

   ```sh
   docker compose --env-file "$ENV_FILE" -p auto24 --profile chromium stop worker-chromium
   docker compose --env-file "$ENV_FILE" -p auto24 up -d --no-build --pull never storage api worker
   ```

   If the API or storage containers come from an older Camoufox image, they can drop the new diagnostics. In that case start them from the Chromium image, which holds the current contracts, with a temporary Compose override that sets `image: auto24-extraction-service:chromium` for `api` and `storage`. The storage volume and configuration stay as they are.

## C2: Plan A reveal and the engine benchmark

### What you will see

A job on Chromium returns the revealed registration number and VIN, with `solver: extension` in the solve record. The benchmark report compares `camoufox/fresh`, `chromium/fresh` and `chromium/shared` side by side.

### How to check

1. Submit a listing with hidden values on Chromium. Confirm `revealed` for both values and compare them with the listing in your own browser.
2. On your `x86_64` server, run the benchmark with `--engine both --mode fresh shared` on your 10 listings. Confirm the side-by-side summary, and that `chromium/fresh` passes 8 of 10 or better, counting capture errors as failures.
3. Repeat step 2 until `chromium/fresh` has passed 3 runs in a row.
4. Confirm that `chromium/shared` reports how many reveals needed no CAPTCHA.

If `chromium/fresh` fails the gate, stop and decide between CloakBrowser (after an audit like the CaptchaRaptor one) and staying on Plan B.

The command for steps 2 and 3 is in [local development](../../local-development.md#benchmark). Step 2 is done as two runs, one per image (see Known gaps), and each engine's gate is computed independently. Replacing Plan B needs 3 passing `chromium/fresh` runs in a row.

## Where to send results

Share the report folders `sandbox-reports/<mode>-<UTC time>/` and `benchmarks/<name>-<UTC time>/`. They hold statuses and hosts, not revealed values. Check any `debug/` folder before sharing: its screenshots mask the value cells but still show the listing page.
