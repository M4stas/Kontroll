# Service checkpoint S2: Chromium capture engine

Status: C1 and C2 are built and pass the offline checks on ARM64. On October 21 you authorized live benchmark runs on the Mac (ARM64), and Chromium passed the first-attempt gate in all 3 runs. The 3-runs-in-a-row replacement rule still needs the x86_64 server, and C1 steps 3 and 4 and C2 steps 1, 3 and 4 are still open.

Authority: [service roadmap](../service-roadmap.md), [spec](../specs/2026-10-19-chromium-extension-engine-design.md), [plan](../plans/2026-10-19-chromium-extension-engine.md).

## Identity integration decisions

One kept profile per worker process lives under `<tmp>/a24-warm/`, outside the `a24-chromium-*` sweep. The worker clears that folder when it starts, so a restart starts a new profile.

The profile resets after 30 jobs, after 10 hours from its creation, and right after any `access_blocked` capture error or `try_again_later` reveal reason. The browser still starts and closes per job.

Only the first session of a job uses the kept profile. A reveal retry session (`reopen`) stays on a fresh profile, because the first session holds the kept profile's lock.

`CHROMIUM_WARM_PROFILE` (default `true`) switches it; `false` keeps today's fresh profile per job.

- The job completes after parsing; identity follows through `POST /internal/jobs/{job_id}/registration`.
- `pending` is a `FieldStatus`. `REVEAL_SECONDS = 120`. A pending field past its deadline reads `unavailable`.
- The reveal token is a new random value per job, separate from the lease token, and is cleared when used.
- The default `worker` runs Chromium; Camoufox stays available as `worker-camoufox` under the `camoufox` profile.
- A warm persistent worker profile is Checkpoint C, after A and B.

## What was built

A second capture engine runs ungoogled-chromium 155.0.8059.84 with Patchright 1.63.0 and a local build of the CaptchaRaptor extension. `CAPTURE_ENGINE=chromium` selects it and Camoufox stays the default. Chromium became the Compose default in S3 Checkpoint A (see the Identity integration decisions section). Pinned inputs are fetched and hash-checked by `scripts/fetch-browser-assets`, and `Dockerfile.chromium` assembles the image with no network during its install steps. The request guard is a per-site allowlist shared by both engines: Auto24, plus the reCAPTCHA paths on Google and Gstatic.

- Redirects are guarded before network contact.
- WebSockets are blocked by a local rule-only guard extension (`src/auto24_service/websocket_guard/`), copied per session. Before the first navigation a loopback canary must be refused, otherwise the launch fails closed (commit `3d4356e`).
- Reveal on Chromium watches the extension solve (`captcha/extension_wait.py`, `solver: extension`). It stops after 20 s without progress, and the value appearing ends the wait.
- `scripts/sandbox-live-capture.py` reveals with the extension on Chromium, so your live sandbox run attempts a solve.
- The benchmark takes `--engine camoufox|chromium|both` and `--mode fresh saved shared` (`both` means `fresh saved`). Results are keyed `<engine>/<mode>`. Only `*/fresh` decides the exit code, and a capture error counts as a failed reveal. `chromium/saved` equals `chromium/fresh` (the report says so). `shared` runs each listing in a new page of one session, so a reveal retry reuses that session's browser context. If the session cannot open on a listing, that listing is recorded as a capture error and the session opens on the next one; only if none opens is every listing a capture error. A run with no `*/fresh` result (shared only) exits 1 and says so.

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

## Live benchmark on the Mac

Run on October 21, 2026, on ARM64 with your listings, at revision `34630c1`. Images were rebuilt from that revision, and the offline sandbox passed on them first (`sandbox-reports/offline-20261021T114457Z`, contacted hosts none). The Camoufox run used the existing `worker` image with the current `src/` mounted, because that image predates the new benchmark flags. Plan B code is unchanged on this branch.

| Run | Engine/mode | Listings | Needed a reveal | Attempt 1 | Retry | Failed | Mean attempt 1 | Grids served | Rounds per reveal |
|---|---|---|---|---|---|---|---|---|---|
| 1 | chromium/fresh | 10 | 9 distinct, 1 repeat | 10 of 10, PASS | 0 | 0 | 6.4 s | 10 × 3x3 | 1 |
| 1 | camoufox/fresh | 10 | 9 distinct, 1 repeat | 9 of 10, PASS | 1 | 0 | 13.2 s | 5 × 3x3, 2 × 4x4, 1 × 3x3 dynamic | 0 to 1 |
| 1 | chromium/shared | 10 | 9 distinct, 1 repeat | 10 of 10, not gated | 0 | 0 | 1.4 s | 2 × 3x3 | 0 to 1 (8 needed no CAPTCHA) |
| 2 | chromium/fresh | 34 | 31 distinct, 3 repeats | 34 of 34, PASS | 0 | 0 | 18.3 s | 47 × 3x3, 17 × 3x3 dynamic | 1 to 3 |
| 3 | chromium/fresh | 34 | 31 distinct, 3 repeats | 34 of 34, PASS | 0 | 0 | 20.2 s | 52 × 3x3, 18 × 3x3 dynamic | 1 to 3 |

- Listings that show no hidden value are skipped (1 in run 1, 3 in runs 2 and 3). The benchmark then reruns listings from the top of the file to reach its target, so "Attempt 1" includes those repeats. Every repeat also passed.
- Camoufox's one failure in run 1 was a 29 s timeout on a 3x3 "stairs" round; attempt 2 revealed it in 18.2 s.
- Every hidden reg number was revealed. VINs were revealed wherever the listing has one.
- No `try_again_later`, no capture errors and no stalls in any run.
- Google served Chromium no 4x4 grid in any run, so the extension's 4x4 performance is still unmeasured live. 4x4 grids caused most of Plan B's earlier failures.
- Plan B's earlier live first-attempt scores were 8, 4, 6, 8, 5 and 3 of 10 ([S1 checkpoint](2026-10-12-registration-reveal-s1.md)).

Reports (Git ignores `benchmarks/`): `c2-mac-chromium-20261021T114559Z`, `c2-mac-camoufox-20261021T114745Z`, `c2-mac-r2-chromium-all-20261021T122457Z`, `c2-mac-r3-chromium-all-20261021T123627Z`.

## Known gaps

- `--engine both` cannot run in either image. The Chromium image has the Camoufox Python package but neither the Camoufox browser nor the solver files, and the `worker-camoufox` image has no Patchright. Ruling: C2 step 2 is done as two runs on the same listings file, one per image. Each engine's gate is computed independently, and the two summaries stand in for the side-by-side summary. The commands are in [local development](../../local-development.md#benchmark).
- amd64 evidence is missing, as above. Run the Chromium test subset on the server with the command in [local development](../../local-development.md#chromium-engine).
- The live runs above were on ARM64, not the x86_64 server the replacement rule names. No live 4x4 grid has reached the extension.

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
   docker compose --env-file "$ENV_FILE" -p auto24 --profile camoufox stop worker-camoufox
   docker compose --env-file "$ENV_FILE" -p auto24 \
     up -d --no-build --pull never storage api worker
   ```

   `worker` defaults to `CAPTURE_ENGINE=chromium`. Open `http://localhost:8000/docs`, authorize with your API key, submit the listing with `POST /v1/jobs`, then poll `GET /v1/jobs/{job_id}`. Check the facts and the diagnostics. Do not run both workers together.

   To compare with Camoufox, stop `worker`, start `worker-camoufox` and submit the same listing:

   ```sh
   docker compose --env-file "$ENV_FILE" -p auto24 stop worker
   docker compose --env-file "$ENV_FILE" -p auto24 --profile camoufox \
     up -d --no-build --pull never storage api worker-camoufox
   ```

   If the API or storage containers come from an older Camoufox image, they can drop the new diagnostics. In that case start them from the Chromium image, which holds the current contracts, with a temporary Compose override that sets `image: auto24-extraction-service:chromium` for `api` and `storage`. The storage volume and configuration stay as they are.

## C2: Plan A reveal and the engine benchmark

### What you will see

A job on Chromium returns the revealed registration number and VIN, with `solver: extension` in the solve record. Two benchmark runs, one per image, give you `camoufox/fresh` and, in the other run, `chromium/fresh` and `chromium/shared` to compare.

### How to check

1. Submit a listing with hidden values on Chromium. Confirm `revealed` for both values and compare them with the listing in your own browser.
2. On your `x86_64` server, run the benchmark twice on the same listings file, once in each image. Camoufox runs in `worker-camoufox` with `--profile camoufox` and `--engine camoufox --mode fresh`. Chromium runs in `worker` with `--engine chromium --mode fresh shared`. Compare the two summaries (`camoufox/fresh` against `chromium/fresh`), and confirm that `chromium/fresh` passes 8 of 10 or better, counting capture errors as failures. The two commands are in [local development](../../local-development.md#benchmark). The spec words this step as "run the benchmark with `--engine both --mode fresh shared` and confirm the side-by-side summary". That cannot run in either image (see Known gaps).
3. Repeat step 2 until `chromium/fresh` has passed 3 runs in a row.
4. Confirm that `chromium/shared` reports how many reveals needed no CAPTCHA.

If `chromium/fresh` fails the gate, stop and decide between CloakBrowser (after an audit like the CaptchaRaptor one) and staying on Plan B.

Replacing Plan B needs 3 passing `chromium/fresh` runs in a row.

## Where to send results

Share the report folders `sandbox-reports/<mode>-<UTC time>/` and `benchmarks/<name>-<UTC time>/`. They hold statuses and hosts, not revealed values. Check any `debug/` folder before sharing: its screenshots mask the value cells but still show the listing page.
