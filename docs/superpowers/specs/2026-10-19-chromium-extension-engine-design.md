# Chromium capture engine with the local CaptchaRaptor extension

Status: design agreed in conversation on October 19, 2026. Awaiting user review of this written spec. No checkpoint is approved yet.

## Outcome

The extraction service gets a second capture engine: ungoogled-chromium, driven by Patchright, with the local-only CaptchaRaptor extension (Plan A) loaded. On this engine the extension solves the reCAPTCHA behind "näita reg. nr." and "näita VIN". The service only clicks the links, waits, and checks the values as it does now.

The engine is built to replace Camoufox later. Once it passes the benchmark, Auto24 capture moves to it, and the MNT vehicle service (`eteenindus.mnt.ee`) will run in the same browser. Those two steps are separate specs. Until then, Camoufox stays the default engine.

## Why

- Plan B (our Python solver in Camoufox) scored 8, 4, 6, 8 and 5 of 10 on attempt 1 across five live benchmarks, and failed most 4x4 grids.
- The user loaded the local extension build in ungoogled-chromium by hand and solved 10 of 10 reveals, 4x4 grids included, quickly.
- That manual test ran with a window, on the user's own IP and profile. This engine measures the same extension under automation in Docker.

## Decisions

- Browser: ungoogled-chromium from the `ungoogled-software/ungoogled-chromium-portablelinux` releases, version 155.0.8059.84-1, both `x86_64_linux.tar.xz` (the user's server) and `arm64_linux.tar.xz` (the user's Mac). Each archive is pinned by SHA-256. A version bump is a deliberate edit and a new review.
- Branded Google Chrome is not an option: since Chrome 137 it ignores `--load-extension`. Chromium builds still honor it.
- Driver: Patchright, a Playwright fork that hides the usual automation signals. It is installed from PyPI at an exact version with pinned hashes. Its own browser download is never used: the engine always passes our ungoogled-chromium as `executable_path`.
- Patchright and Chromium are pinned as a pair. Patchright is built against one Chromium version, so a custom executable needs proof that the two work together: the real-extension smoke test (see Testing) runs on that exact pair on both architectures. The plan's first task picks the Patchright release that matches Chromium 155 and records both versions next to each other.
- Updates: the browser opens real websites, so Chromium security fixes matter. Chromium and Patchright are bumped together at least monthly, and soon after any Chromium security release. Each bump updates the hash pins and reruns the smoke tests on both architectures and the offline sandbox before it is merged.
- Display: Xvfb by default, so the browser runs with a normal window on a virtual screen, as in the manual test. `CHROMIUM_HEADLESS=true` switches to `--headless=new`. Only Xvfb is benchmarked for now.
- Xvfb comes from Debian's signed repository (package `xvfb`, X.Org, MIT/X11 license) and starts with `-nolisten tcp`, so it is reachable only through a local socket inside the container.
- Extension: built in the image by `scripts/captcharaptor/build_extension.py` from the pinned CaptchaRaptor and onnxruntime-web tarballs. Every copied file is pinned. Its behavior is described in `scripts/captcharaptor/README.md`.
- Inputs live outside the repository, like the solver files. No asset is committed.
- Engine choice: `CAPTURE_ENGINE=camoufox|chromium`, default `camoufox`. Any other value stops the worker at startup.

## Browser assets

`scripts/fetch-browser-assets` downloads four inputs into `~/.cache/auto24/browser-assets/` and checks each against `vendor/browser-assets/SHA256SUMS`:

| Input | Source |
| --- | --- |
| `ungoogled-chromium-155.0.8059.84-1-x86_64_linux.tar.xz` | GitHub release of `ungoogled-software/ungoogled-chromium-portablelinux` |
| `ungoogled-chromium-155.0.8059.84-1-arm64_linux.tar.xz` | the same release |
| `captchaplugin-7462474.tar.gz` | `codeload.github.com/CaptchaRaptor/captchaplugin` at commit `7462474d5fdfda5618becc9ac7a421de3ea69495` |
| `onnxruntime-web-1.22.0.tgz` | `registry.npmjs.org` |

The script prints `verified:` for each file and refuses a file whose hash differs. It skips a download when a verified file is already cached.

## Image

`Dockerfile.chromium` builds from the same Debian base as the current image:

- It receives the asset folder through `additional_contexts`, as the solver files do.
- It unpacks the browser archive that matches `TARGETARCH` (`amd64` uses `x86_64`, `arm64` uses `arm64`) after `sha256sum -c`.
- It installs `xvfb` and Chromium's runtime libraries from Debian.
- It runs `build_extension.py` and checks that `BUILD-INFO.txt` lists the pinned files.
- It installs Patchright with `pip install --require-hashes`.
- It runs `chromium --version` once, so a missing runtime library fails the image build and not the first job.
- The build fails on any hash mismatch or a missing input.

The existing Camoufox image is unchanged.

## Service components

**`browser_chromium.py`** launches the engine and returns the same `ListingSession` that `browser.open_listing` returns for Camoufox. Capture, parsing and reveal code stay shared.

- It starts Xvfb on a free display number, unless headless is set.
- It launches a persistent context in a new temporary profile with `--load-extension` and `--disable-extensions-except` for our extension only.
- It passes flags that turn off background traffic: no DNS prefetch or preconnect, no component or field-trial updates, no Safe Browsing lookups, no sign-in, sync or translate, no metrics, and WebRTC limited to the default route. The offline sandbox decides whether more flags are needed.
- It checks that the extension is ready, not only loaded. It first looks at the service workers that already exist, then waits for one, so a worker that started early is not missed. It accepts only a worker at our extension's ID, which is fixed by the build. It then runs one call in that worker that reads the bundled sqlite database. The check gets at most 5 s and never more than the lease has left. If it fails, the capture fails with `extension_not_loaded`.
- Model loading happens lazily in the reCAPTCHA frame, so this check cannot cover it. The real-extension smoke test does.
- Cleanup runs on every exit path: a normal close, a launch failure, a readiness failure, a timeout, a crash and worker shutdown. Each path closes Chromium, kills its process group, stops Xvfb and deletes the temporary profile. The worker removes leftovers from an earlier crash at startup. Each path has a test.

**Request guard.** The current guard becomes a per-site allowlist shared by both engines:

- Auto24: main frame `www.auto24.ee`; subresources from `www.auto24.ee` and the reCAPTCHA paths on `www.google.com` and `www.gstatic.com`, the same hosts the Camoufox guard allows now.
- On Chromium, `chrome-extension://` requests are allowed only for our extension's ID.
- The path rules stay: `..`, `%` and `\` are rejected. Blocked requests are still listed in `blocked_requests`.
- MNT gets its own allowlist entry in its own spec.

**What the guard does not cover.** Playwright's routing sees page and frame requests only. Each gap has its own protection:

| Traffic | Seen by the guard | Protection |
| --- | --- | --- |
| Page and frame requests | yes | the allowlist above |
| Website service workers, whose requests skip page routing | no | website service workers are blocked (`service_workers="block"`), so none register |
| The extension's service worker | no | the extension's CSP allows `connect-src 'self'` only, and its code makes no other request |
| Chromium's own background traffic (updates, Safe Browsing, DNS prefetch and the like) | no | the launch flags, checked by the offline sandbox |

Each protection gets a negative test that deliberately tries a forbidden connection and checks that it is stopped: a page fetch to a foreign host, a website trying to register a service worker, the extension worker trying a `fetch` to a foreign host, and the offline sandbox's existing canary for background traffic.

**Reveal on Chromium.** `reveal.py` keeps the trigger clicks, the value checks against Auto24's JSON, the 90 s attempt cap, the retry in a fresh session, the lease deadline and the diagnostics. Only the solving step differs:

- It does not drive the widget. It waits while the extension opens the checkbox and solves.
- It records rounds from the challenge frame's `reload`, `payload` and `userverify` replies, as Plan B's driver reads them.
  - A round is one challenge, keyed by the challenge id Google sends in `reload` or `userverify`. A reply with an id already seen belongs to the same round, so one challenge never counts twice.
  - Tiles that refill in a dynamic 3x3 grid belong to the same round, as in Plan B. A round ends with a `userverify` reply.
  - Grid size and label are recorded when that data has them.
  - A reply in an unknown format marks the round's diagnostics `incomplete`. It never rejects a value that passed the checks.
- Progress resets the 20 s stall timer. It means only: a new round, new tile images in the open challenge, the checkbox ticking, or the value appearing. Other network traffic, including repeated replies for the same round, does not count.
- It polls the row and Auto24's JSON, and accepts the value through the existing checks.
- Round records carry `solver: "extension"`. Tile-level records are left empty, because the extension's picks cannot be seen from outside.

## Failures

| What happens | Result |
| --- | --- |
| Xvfb or Chromium fails to start | capture fails with `browser_launch`; the job retries as it does now |
| The extension's service worker is missing, has the wrong ID or fails its sqlite call within 5 s (or the lease) | capture fails with `extension_not_loaded` |
| No progress, as defined above, for 20 s | the attempt ends with `timeout` at stage `stall`, so the fresh-session retry still fits in the lease |
| Google shows "try again later" | `try_again_later` |
| 3 or more rounds without a pass | `captcha_rounds_exhausted` |
| The value fails the JSON, format or prefix check | `value_rejected` or `prefix_mismatch` |
| Chromium crashes during a reveal | the existing crash path: the reveal is `unavailable` and the job completes |

## Data contract

- `AttemptRecord` and `RoundRecord` get an optional `solver` field: `"python"` for Plan B, `"extension"` for Plan A. Older records without it read as `"python"`.
- Capture diagnostics get `engine` (`camoufox` or `chromium`) and, on Chromium, `extension_loaded`.
- All new fields are additive with defaults. The TS app ignores them, as it ignores the current reveal diagnostics.

## Privacy

- Diagnostics, logs, progress lines and benchmark reports hold no revealed values, as now.
- Debug screenshots keep the value-cell masking. On Chromium the screenshot call is the same Playwright API.
- The temporary profile is deleted after each capture. In the benchmark's `shared` mode it is deleted at the end of the run.
- The extension contacts nothing itself; that was checked in the build review and by the user's manual Network-tab check. The offline sandbox checks the browser's own background traffic.

## Benchmark

`captcha_benchmark` gets two options:

- `--engine camoufox|chromium|both`, default `camoufox`.
- `--mode fresh|saved|shared`, which may list several. `shared` keeps one browser running for the whole run and opens each listing in a new tab. It shows whether a solved CAPTCHA carries over to later listings.

The report lists each engine and mode combination side by side, with attempt-1 and retry passes, rounds, timings and the count of `no_captcha_needed` reveals.

The gate:

- It applies to `chromium/fresh` on the user's `x86_64` server, because production starts each job fresh on that machine. Runs on the Mac and `shared` results are reported, but they do not decide the gate.
- A pass means both requested values were revealed and validated within the worker's lease deadline, on attempt 1 and within 3 rounds.
- A capture error counts as a failed reveal. Today the benchmark skips capture errors before counting them, which would hide failures such as `extension_not_loaded`; that is fixed.
- At least 8 of 10 must pass. Plan B varied from 4 to 8 of 10 between runs, so replacing it needs 3 passing runs in a row, not one.

## Testing

Offline, with no live site:

- `build_extension.py`: the existing tests.
- `fetch-browser-assets`: hash checks, a cached file, a wrong file and a missing file, against local fixture files.
- The Chromium engine against the existing fake site, with a test-only extension that stands in for CaptchaRaptor: it clicks the fake checkbox and answers the fake grid. These tests cover what the real extension cannot be made to do on demand: launch, readiness, `extension_not_loaded`, the 20 s stall cap, round counting, a crash during a reveal, every cleanup path, and both values revealed and checked.
- A real-extension smoke test with the actual built CaptchaRaptor and its bundled inputs. The fake site serves fake `www.google.com/recaptcha` frames, so the extension's content script runs there. It must load its ONNX models, the onnxruntime wasm and the sqlite database, then pick tiles and press verify on a fake 3x3 and a fake 4x4 grid. The fake images are synthetic, so the test checks that an answer was submitted, not that it was right. This proves model readiness and the Patchright and Chromium pair.
- The guard's negative tests, one for each protection.
- The full Python suite on `arm64`. The real-extension smoke test and a small Chromium subset run on `x86_64` through Docker's emulation. The user's server is the full `x86_64` check.
- The offline network sandbox on the Chromium image.

The user runs all live checks: the live sandbox, the live capture and the benchmark.

## Checkpoints

### C1: Auto24 capture on Chromium

#### Before starting

- The user approves this spec and the plan.
- Write `scripts/fetch-browser-assets`, `vendor/browser-assets/SHA256SUMS`, `Dockerfile.chromium`, the shared per-site allowlist and `browser_chromium.py`.

#### What you will see

With `CAPTURE_ENGINE=chromium`, a job submitted on the API docs page completes with the same listing data as a Camoufox capture. Its diagnostics show `engine: chromium` and `extension_loaded: true`. No reveal runs yet.

#### How to check

1. Run `scripts/fetch-browser-assets`. Confirm `verified:` for all four inputs.
2. Build the Chromium image and run the offline sandbox on it. Confirm PASS with no hosts contacted.
3. Run the live sandbox on one listing. Confirm only `www.auto24.ee`, `www.google.com` and `www.gstatic.com`.
4. Start the stack with `CAPTURE_ENGINE=chromium` and submit a listing. Compare its facts with a Camoufox capture of the same listing.

### C2: Plan A reveal and the engine benchmark

#### What you will see

A job on Chromium returns the revealed registration number and VIN, with `solver: extension` in the solve record. The benchmark report compares `camoufox/fresh`, `chromium/fresh` and `chromium/shared` side by side.

#### How to check

1. Submit a listing with hidden values on Chromium. Confirm `revealed` for both values and compare them with the listing in your own browser.
2. On your `x86_64` server, run the benchmark with `--engine both --mode fresh shared` on your 10 listings. Confirm the side-by-side summary, and that `chromium/fresh` passes 8 of 10 or better, counting capture errors as failures.
3. Repeat step 2 until `chromium/fresh` has passed 3 runs in a row.
4. Confirm that `chromium/shared` reports how many reveals needed no CAPTCHA.

If `chromium/fresh` fails the gate, stop and decide between CloakBrowser (after an audit like the CaptchaRaptor one) and staying on Plan B.

## Out of scope

- Removing Camoufox. It follows if C2 passes, in its own spec.
- MNT capture on the same browser.
- Keeping a browser warm between worker jobs. The `shared` benchmark mode measures whether it helps first.
- Benchmarking headless mode. The flag exists, and it gets measured only if Xvfb passes and the server's memory or CPU turns out tight.
- CloakBrowser and other Chromium forks.
