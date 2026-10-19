# Chromium capture engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ungoogled-chromium capture engine, driven by Patchright with the local CaptchaRaptor extension loaded, selectable with `CAPTURE_ENGINE`, and benchmark it against Camoufox.

**Architecture:** A new `browser_chromium.py` opens the same `ListingSession` that `browser.open_listing` returns, so capture, parsing and reveal code stay shared. The request guard moves to `guard.py` as a per-site allowlist both engines use. `reveal.py` takes an injected solve step: Plan B keeps `solve_recaptcha`, and Plan A uses a watcher that only observes the extension's work and counts rounds.

**Tech Stack:** Python 3.12, Patchright (Playwright fork), ungoogled-chromium 155 portable Linux, Xvfb, Docker, pytest.

**Spec:** [docs/superpowers/specs/2026-10-19-chromium-extension-engine-design.md](../specs/2026-10-19-chromium-extension-engine-design.md)

**Agents:** model and thinking level for each role come from [docs/agent-policy.md](../../agent-policy.md). Each task names its role only.

## Checkpoints at a glance

The spec's two checkpoints are split into seven, so each one gives a result you can check yourself. CP1 to CP4 make up the spec's C1, and CP5 to CP7 make up C2.

| CP | You can check | Tasks | Runs in parallel |
| --- | --- | --- | --- |
| 1 | Pinned downloads verify, the extension has a fixed ID in Chromium, and the benchmark report counts capture errors | 1, 2, 3 | 1 ∥ 2 ∥ 3 |
| 2 | The Chromium image builds on both architectures, and Camoufox still passes its sandbox after the guard refactor | 4, 5 | 4 ∥ 5 |
| 3 | A screenshot of Chromium opening the fake listing with the extension ready, and a clean offline sandbox | 6, 7, 8 | 6 ∥ 7, then 8 |
| 4 | A real job on Chromium on the API docs page, with no leftover browser processes between jobs | 9, 10 | 9 ∥ 10 |
| 5 | The real extension picking tiles on fake 3x3 and 4x4 grids, on both architectures | 11, 12, 13 | 11, then 12 ∥ 13 |
| 6 | The registration number and VIN revealed on Chromium, on the fake site and on a real listing | 14, 15 | 14 ∥ 15 |
| 7 | One benchmark report comparing `camoufox/fresh`, `chromium/fresh` and `chromium/shared` | 16 | none |

Then come your gate runs, outside the numbered checkpoints.

### How parallel work runs

- Each parallel task runs in its own worktree (`delegate_task` with `isolation: "worktree"`), started from the latest local commit. The coordinator merges each task's branch after its review passes, in the order the table gives.
- Parallel tasks never share a file. Where two tasks touch neighbouring code, the plan names which one merges first.
- Reviews run in parallel with the next task. The policy prefers independent agents for reviews and tests.
- **Early starts, only with your approval:** Tasks 11 and 12 (contract fields and the round tracker) have no C1 dependency and could run during CP2 or CP3. They are listed under CP5 so that nothing starts before you approve it.

## Global Constraints

- Chromium: ungoogled-chromium `155.0.8059.84-1`, archives `x86_64_linux.tar.xz` and `arm64_linux.tar.xz`, each pinned by SHA-256.
- Patchright: `1.64.1` (see Decisions). Installed with `pip install --require-hashes`. Its own browser download is never used; `executable_path` is always our Chromium.
- CaptchaRaptor tarball `captchaplugin-7462474.tar.gz` (commit `7462474d5fdfda5618becc9ac7a421de3ea69495`) and `onnxruntime-web-1.22.0.tgz`, with the hashes already in `scripts/captcharaptor/build_extension.py`.
- No browser asset is committed. Inputs live in `~/.cache/auto24/browser-assets/`.
- `CAPTURE_ENGINE=camoufox|chromium`, default `camoufox`. Any other value stops the worker at startup.
- `CHROMIUM_HEADLESS=true` adds `--headless=new`. Otherwise Xvfb runs, started with `-nolisten tcp`.
- The extension readiness check gets at most 5 s, and never more than the lease has left.
- Stall cap: 20 s without progress. Attempt cap: 90 s. Rounds: 3 per attempt.
- Revealed values never appear in diagnostics, logs, progress lines or benchmark reports.
- New contract fields are additive with defaults. `JobErrorCode` does not change.
- The Camoufox image (`Dockerfile`) does not change.
- No `--no-sandbox`, no `SYS_ADMIN`, no `seccomp=unconfined`. If Chromium cannot start without one of them, stop and report it.

## Decisions made while planning

Facts checked on 2026-10-19:

- **Chromium archive digests from the GitHub release:**
  - x86_64: `7e376c47b2650f846984f32e4962b33703e5abe09681009cf4f3f336e1125f13`
  - arm64: `5b4de24d19d7a5e5240233a4efd2f1f62be50f82793ee1b90673479148474ade`
  - Task 1 downloads both archives and checks them against these values, so the two sources confirm each other.
- **Patchright:** no release is built for Chromium 155. Playwright 1.63 bundles Chromium 153 and 1.64 bundles 156. This plan picks Patchright `1.64.1`. Playwright tests each release against the current Chrome stable channel, which is usually one major version behind its bundled Chromium, so 155 with 1.64 is that same tested pairing. The real-extension smoke test (Task 13) on both architectures is the proof. If it fails, stop and report; do not switch versions without the user.
- **Fixed extension ID:** the build has no manifest `key` today, so Chromium derives the ID from the folder path. Task 2 adds a public key, which fixes the ID. The private key is never kept.
- **Image layering:** `Dockerfile.chromium` starts `FROM auto24-extraction-service:compose`, which already sits on the same Debian base. The Chromium image therefore also contains Camoufox and the solver files, so `captcha_benchmark --engine both` runs in one container. `scripts/build-chromium-image` builds the compose image first.
- **Failure codes:** `browser_launch` and `extension_not_loaded` are `CaptureError` codes. The worker maps them to `temporary_failure` as it does any unknown code, and logs the original as `cause=`. The benchmark reports them by name.
- **Where `engine` lives:** "capture diagnostics" in the spec means `RevealDiagnostics`, the only diagnostics the job stores. It gets `engine` and `extension_loaded`.
- **No reveal before CP6:** on Chromium, hidden fields read `unavailable` with no attempts until Task 15 switches in the Plan A reveal.
- **Shared benchmark mode:** applies to Chromium only. With `--engine both`, `camoufox/shared` is skipped and named in the report. A retry in shared mode still launches a fresh browser on its own thread, because sync Playwright cannot share a browser across threads.
- **Demo command:** `scripts/chromium-demo` (Task 8) gives you something to look at before the full stack runs. It opens the fake listing in the Chromium image, prints statuses and the extension ID, and saves a screenshot to `demo-output/`. The fake site's values are made up.

## Review Focus

1. Two jobs in a row in one worker process on Chromium: the second gets a new display and profile, and nothing from the first is left running. *(Task 9: `test_two_captures_in_a_row_leave_nothing_behind`)*
2. Chromium crashes in the middle of a job: the job still completes, and the next job starts cleanly. *(Task 9: `test_crash_mid_session_is_cleaned_and_next_launch_works`)*
3. The lease has less than 5 s left when the engine launches: readiness uses only what is left and fails with `extension_not_loaded`, without hanging. *(Task 6: `test_readiness_never_outlives_the_deadline`)*
4. A listing with nothing hidden on Chromium: there is no reveal, and the diagnostics still show `engine: chromium`. *(Task 10: `test_chromium_capture_without_hidden_fields_reports_engine`)*
5. `CAPTURE_ENGINE` written as ` Chromium ` or `CHROMIUM`: accepted the way `REVEAL_FORCE_FAILURE` is (strip, casefold). `firefox` stops startup. *(Task 10: `test_capture_engine_values`)*

## Running tests

Browser tests run in Docker. Unit tests run anywhere:

- Camoufox image: `scripts/pytest-service <args>` (unchanged).
- Chromium image: `PYTEST_SERVICE_IMAGE=auto24-extraction-service:chromium scripts/pytest-service <args>` (added in Task 4).
- x86_64 on the Mac: `scripts/build-chromium-image --platform linux/amd64`, then the same command with `PYTEST_SERVICE_PLATFORM=linux/amd64`.

Chromium tests skip when `patchright` is missing or `CHROMIUM_EXECUTABLE` is not a file. Real-extension tests also skip when `CAPTCHARAPTOR_DIR` is not a folder. The Chromium image sets `AUTO24_REQUIRE_CHROMIUM=1`, and with it set each Chromium test module fails instead of skipping, so nothing skips there.

The Chromium offline sandbox runs `tests/test_chromium_*.py tests/test_captcharaptor_*.py`. Task 7 sets this glob once, so later test files join it without editing the script.

---

# CP1: Pinned inputs, a fixed extension ID and an honest benchmark count

## Before starting

- The user approved the spec and this plan.
- Commit the plan and the spec status change, so worktrees start from them.

## What you will see

`scripts/fetch-browser-assets` downloads and verifies the four inputs, and refuses a changed file. A fresh extension build names its extension ID, and Chromium shows that same ID when you load the build by hand from any folder. The benchmark report groups results as `camoufox/fresh`, names your machine, and counts a capture error as a failed reveal.

## How to check

1. Run `scripts/fetch-browser-assets`. Confirm four `verified:` lines.
2. Append one byte to `~/.cache/auto24/browser-assets/onnxruntime-web-1.22.0.tgz`, then run the script again. Confirm it refetches that file and prints `verified:` again.
3. Build the extension with the commands in `scripts/captcharaptor/README.md`, and read `extension id:` in `BUILD-INFO.txt`.
4. Copy the build folder to a second place. In ungoogled-chromium, load both copies with Load unpacked, one after the other, in a fresh test profile. Confirm `chrome://extensions` shows the ID from step 3 both times.
5. Run a short Camoufox benchmark: `--engine camoufox --mode fresh --reveals 2` on two of your listings. In `report.md`, confirm the `camoufox/fresh` heading, your machine name, and `deciding_combination: None` on the Mac.

### Task 1: Browser asset pins and fetch script

Role: small implementation changes and focused tests. Parallel with Tasks 2 and 3.

**Files:**
- Create: `vendor/browser-assets/SHA256SUMS`, `vendor/browser-assets/SOURCES`, `vendor/browser-assets/VERSIONS`, `scripts/fetch-browser-assets`
- Test: `tests/test_fetch_browser_assets.py`

**Interfaces:**
- Produces:
  - `SHA256SUMS`: four `sha256sum` lines for the files in spec "Browser assets".
  - `SOURCES`: one `<file name> <url>` line per file.
  - `VERSIONS`: `chromium 155.0.8059.84-1` and `patchright 1.64.1` on adjacent lines.
  - `scripts/fetch-browser-assets [--sums FILE] [--sources FILE] [--cache DIR]` downloads into `--cache` (default `~/.cache/auto24/browser-assets`) and prints `verified: <name>` per file. Exit 0 when all four are verified, 1 otherwise.

- [ ] **Step 1: Write the failing tests.** They use local fixture files and `file://` URLs in a temporary `SOURCES`, so no network is needed:
  - `test_downloads_and_verifies_each_file`: exit 0, four `verified:` lines, all four files cached.
  - `test_cached_verified_file_is_not_downloaded_again`: the second run succeeds after the fixture source is deleted.
  - `test_wrong_file_is_refused_and_removed`: exit 1, and that file is not left in the cache.
  - `test_cached_file_with_wrong_hash_is_fetched_again`
  - `test_missing_source_fails`: exit 1.
- [ ] **Step 2:** Run `python -m pytest tests/test_fetch_browser_assets.py -v`. Expected: FAIL (script missing).
- [ ] **Step 3: Write the script.** Follow `scripts/fetch-captcha-solver`: `set -euo pipefail`, `sha256sum` or `shasum -a 256`. Download each file to `<name>.part` with `curl -sSfL`, check it, then `mv` it into place, so a failed download never sits under its final name. Fill in `SHA256SUMS`:
  - Chromium: the GitHub digests listed in Decisions.
  - `captchaplugin-7462474.tar.gz`: `TARBALL_SHA256`.
  - `onnxruntime-web-1.22.0.tgz`: `ORT_TARBALL_SHA256`.
  - URLs: the Chromium release assets, `https://codeload.github.com/CaptchaRaptor/captchaplugin/tar.gz/7462474d5fdfda5618becc9ac7a421de3ea69495` and `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.22.0.tgz`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `scripts/fetch-browser-assets` for real once. Expected: four `verified:` lines.
- [ ] **Step 5:** Commit: `build: pin and fetch the Chromium engine's browser assets`.

### Task 2: Fixed extension ID

Role: small implementation changes and focused tests. Parallel with Tasks 1 and 3.

**Files:**
- Modify: `scripts/captcharaptor/build_extension.py` (`manifest()`, `write()`), `scripts/captcharaptor/README.md`
- Test: `tests/test_build_extension.py`

**Interfaces:**
- Produces:
  - `EXTENSION_PUBLIC_KEY: str`: base64 DER SubjectPublicKeyInfo of a new RSA-2048 key.
  - `EXTENSION_ID: str`: the 32 letters `a`-`p` derived from it.
  - `extension_id(public_key_b64: str) -> str`: the first 16 bytes of SHA-256 over the DER bytes, each hex digit mapped `0`-`f` to `a`-`p`.
  - `manifest()["key"] == EXTENSION_PUBLIC_KEY`.
  - `BUILD-INFO.txt` gets an `extension id: <EXTENSION_ID>` line.

- [ ] **Step 1: Write the failing tests.**
  - `test_manifest_key_fixes_the_extension_id`: `extension_id(EXTENSION_PUBLIC_KEY) == EXTENSION_ID`, and `manifest()["key"] == EXTENSION_PUBLIC_KEY`.
  - `test_extension_id_matches_chromium_derivation`: a known key and ID pair taken from Chromium's documentation or source, so the derivation is checked against Chromium and not only against itself.
  - `test_build_info_names_the_extension_id`
- [ ] **Step 2:** Run `python -m pytest tests/test_build_extension.py -v`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Generate the key with `openssl genrsa 2048 | openssl rsa -pubout -outform DER | base64`, keep only the public part, and delete the private key. The local-only tripwire must still pass. Mention the fixed ID in the README's Load section.
- [ ] **Step 4:** Run the tests. Expected: PASS, including every existing build test.
- [ ] **Step 5:** Commit: `build: fix the local extension's ID with a manifest key`.

### Task 3: Benchmark engines, modes and the capture-error count

Role: small implementation changes and focused tests. Parallel with Tasks 1 and 2.

The CLI and report part of the old benchmark task. It uses only the injected `capture`, so it needs no Chromium code. `--engine chromium` exits 2 with `chromium engine is not available yet` until Task 10 adds the opener.

**Files:**
- Modify: `src/auto24_service/captcha_benchmark.py`
- Test: `tests/test_captcha_benchmark.py`

**Interfaces:**
- Produces:
  - `--engine camoufox|chromium|both`, default `camoufox`.
  - `--mode` takes one or more of `fresh saved shared`, default `fresh saved`. `both` is kept as an alias for `fresh saved`.
  - `main(argv, *, capture=None, solver_loader=None, openers: dict[str, Callable] | None = None)`: `openers` maps an engine to its opener. Tests pass fakes, and `None` means the built-in ones.
  - Report combinations are keyed `"<engine>/<mode>"`. `camoufox/shared` is skipped and listed under `skipped_combinations`.
  - Each combination adds `no_captcha_needed`, the count of reveals whose attempt 1 outcome is `no_captcha_needed`.
  - Report header fields: `chromium_version` (from `vendor/browser-assets/VERSIONS` when present), `patchright_version`, `machine` (`platform.machine()`), and `deciding_combination: "chromium/fresh"` when `machine == "x86_64"`, otherwise `None`.
  - Gate: capture errors count as attempted failures. `capture_errors` still counts them by code.

- [ ] **Step 1: Write the failing tests.**
  - `test_capture_error_counts_as_a_failed_reveal`: change `test_capture_error_is_counted_and_report_still_written`. 8 successes and 2 `extension_not_loaded` errors give `attempted == 10`, `success_attempt_1 == 8`, `gate == "PASS"` and `capture_errors == {"extension_not_loaded": 2}`. 7 and 3 give FAIL.
  - `test_engine_both_with_fresh_and_shared_reports_three_combinations`: the keys are `{"camoufox/fresh", "chromium/fresh", "chromium/shared"}`, and `skipped_combinations == ["camoufox/shared"]`.
  - `test_mode_accepts_several_values_and_both_alias`
  - `test_report_names_versions_machine_and_deciding_combination`: monkeypatch `platform.machine`.
  - `test_no_captcha_needed_is_counted_per_combination`
  - `test_chromium_engine_unavailable_exits_2` (removed again in Task 10)
- [ ] **Step 2:** Run `python -m pytest tests/test_captcha_benchmark.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: group benchmark results by engine and mode and count capture errors`.

### CP1 close-out

- [ ] An independent code review of each task (in parallel). Merge in the order 1, 2, 3.
- [ ] The coordinator reruns the tests and writes `docs/superpowers/checkpoints/2026-10-xx-chromium-cp1.md` with the evidence and the "How to check" steps, then stops for the user.

---

# CP2: The Chromium image

## What you will see

`scripts/build-chromium-image` builds an image with ungoogled-chromium 155, Xvfb, Patchright and the extension, for arm64 and x86_64. A changed archive stops the build. Camoufox captures behave exactly as before, now behind the shared guard.

## How to check

1. Run `scripts/build-chromium-image`. Then run `docker run --rm --entrypoint chromium auto24-extraction-service:chromium --version` and confirm `155.0.8059.84`.
2. Append one byte to the cached `x86_64_linux.tar.xz` archive, run `scripts/build-chromium-image --platform linux/amd64`, and confirm it fails on the hash. Run `scripts/fetch-browser-assets` to restore the file, then confirm the amd64 build succeeds.
3. Read the Task 4 findings in this plan. Confirm Chromium runs with its sandbox and no extra container privileges.
4. Run `scripts/network-sandbox offline` (Camoufox). Confirm PASS with no hosts contacted.
5. Run `scripts/network-sandbox live --url <listing>` (Camoufox). Confirm the same three hosts as before.

### Task 4: Chromium image

Role: integration, database work, and debugging. Parallel with Task 5.

**Files:**
- Create: `Dockerfile.chromium`, `scripts/build-chromium-image`, `vendor/browser-assets/patchright-requirements.txt`
- Modify: `scripts/pytest-service` (honor `PYTEST_SERVICE_IMAGE` and `PYTEST_SERVICE_PLATFORM`; defaults unchanged)

**Interfaces:**
- Consumes: Task 1's cache folder and `VERSIONS`, Task 2's build.
- Produces:
  - Image `auto24-extraction-service:chromium`.
  - `chromium` on `PATH` and `/opt/ungoogled-chromium/chrome`.
  - The extension in `/opt/captcharaptor`.
  - `ENV CHROMIUM_EXECUTABLE=/opt/ungoogled-chromium/chrome CAPTCHARAPTOR_DIR=/opt/captcharaptor AUTO24_REQUIRE_CHROMIUM=1`.
  - Non-root user `capture`, which the Chromium engine runs as.
  - `scripts/build-chromium-image [--platform P]` builds the compose image, then this one, with `--build-context browser_assets=$HOME/.cache/auto24/browser-assets`.

- [ ] **Step 1: Probe before writing the Dockerfile.** In a throwaway container from `auto24-extraction-service:compose`, under Docker's default seccomp profile and as a non-root user, find out:
  - which Debian runtime libraries `chrome` needs: run `ldd`, then confirm by launching;
  - whether Chromium starts with its sandbox and no extra privileges;
  - whether Patchright `1.64.1` `launch_persistent_context(executable_path=..., headless=False, args=[--load-extension, --disable-extensions-except])` under Xvfb shows a service worker at `chrome-extension://<EXTENSION_ID>/`;
  - whether Patchright adds `--disable-extensions` by default (in that case it goes in `ignore_default_args`);
  - whether page routing sees requests from the cross-origin reCAPTCHA frames and from `chrome-extension://` resources.

  Report the findings to the coordinator, who records them under "Findings" below. **If the sandbox needs `--no-sandbox` or extra privileges, stop here.** The user decides.
- [ ] **Step 2: Generate `patchright-requirements.txt`.** It holds `patchright==1.64.1` and its dependency tree, with `--hash` lines covering the cp312 manylinux x86_64 and aarch64 wheels.
- [ ] **Step 3: Write `Dockerfile.chromium`.**
  - Unpack the archive that matches `TARGETARCH` (`amd64` uses `x86_64`, `arm64` uses `arm64`) after `sha256sum -c` against the copied `SHA256SUMS` lines.
  - `apt-get install xvfb` plus the libraries from Step 1.
  - Run `build_extension.py` into `/opt/captcharaptor`, then `grep -q "extension id: <EXTENSION_ID>"` and check every pinned path against `BUILD-INFO.txt`.
  - `pip install --require-hashes -r vendor/browser-assets/patchright-requirements.txt`.
  - Run `chromium --version` as a build step, and `rm` the downloaded tarballs.
- [ ] **Step 4: Verify.**
  - `scripts/build-chromium-image` succeeds.
  - The version command prints `155.0.8059.84`.
  - A changed archive byte fails the build.
  - `--platform linux/amd64` also succeeds.
- [ ] **Step 5:** Commit: `build: add the ungoogled-chromium image with the local extension`.

#### Findings

*(Coordinator fills this in from Task 4 Step 1 before Task 6 starts.)*

### Task 5: Shared per-site guard

Role: small implementation changes and focused tests. Parallel with Task 4.

**Files:**
- Create: `src/auto24_service/guard.py`
- Modify: `src/auto24_service/browser.py` (`_allowed_url`, `_blocked_entry`, `ListingSession`, `guard_request` in `_navigate`)
- Test: `tests/test_guard.py`. `tests/test_browser.py` must keep passing unchanged.

**Interfaces:**
- Produces:
  - `SiteAllowlist(main_frame_hosts: frozenset[str], subresource_hosts: frozenset[str], subresource_prefixes: tuple[str, ...])`, a frozen dataclass.
  - `AUTO24: SiteAllowlist`, with the current Camoufox values.
  - `allowed_url(url: str, *, main_frame: bool, site: SiteAllowlist = AUTO24) -> bool`
  - `allowed_extension_url(url: str, extension_id: str | None) -> bool`
  - `blocked_entry(url: str) -> str`
  - `ListingSession` gains:
    - `engine: Literal["camoufox", "chromium"] = "camoufox"`
    - `extension_id: str | None = None`
    - `extension_loaded: bool | None = None`
  - `browser._allowed_url(url, *, main_frame)` keeps its signature, because tests monkeypatch it. `guard_request` checks `allowed_extension_url(url, session.extension_id)` first for `chrome-extension:` URLs.

- [ ] **Step 1: Write the failing tests.**
  - `test_auto24_allowlist_matches_the_camoufox_guard`: the parametrized cases from `test_guard_allows_only_recaptcha_paths_on_google_hosts`, run through `guard.allowed_url`.
  - `test_extension_urls_allowed_only_for_our_id`:
    - Our ID: allowed.
    - Another ID: blocked.
    - `None`: blocked.
    - `..`, `%2e` and `\` in the path: blocked.
    - As a main frame: blocked.
  - `test_path_rules_reject_dot_dot_percent_and_backslash`
- [ ] **Step 2:** Run `python -m pytest tests/test_guard.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Move the logic out of `browser.py` without changing behavior.
- [ ] **Step 4:** Run `python -m pytest tests/test_guard.py tests/test_browser.py -v`, and `scripts/network-sandbox offline`. Expected: PASS.
- [ ] **Step 5:** Commit: `refactor: share the request guard as a per-site allowlist`.

### CP2 close-out

- [ ] Reviews of Tasks 4 and 5 in parallel. Merge 5, then 4.
- [ ] The coordinator records the findings, writes the CP2 checkpoint note, and stops for the user.

---

# CP3: Chromium opens the fake listing with the extension ready

## What you will see

`scripts/chromium-demo` opens the fake listing in Chromium inside the Docker image. It prints `engine: chromium`, the extension ID and `extension_loaded: true`, and saves a screenshot of the page. With a broken extension, it prints `extension_not_loaded` within 5 s. The offline sandbox on the Chromium image passes with no hosts contacted.

## How to check

1. Run `scripts/chromium-demo`. Confirm the three printed lines, and that the ID matches `BUILD-INFO.txt`. Open `demo-output/listing.png` and confirm the fake listing with its hidden fields.
2. Run `scripts/chromium-demo --extension test-no-worker`. Confirm `capture failed: extension_not_loaded` in under 6 s.
3. Run `scripts/chromium-demo --headless`. Confirm the same output as step 1.
4. Run `scripts/network-sandbox offline --engine chromium`. Confirm PASS with no hosts contacted.

### Task 6: Chromium launcher and extension readiness

Role: integration, database work, and debugging. Parallel with Task 7.

**Files:**
- Create: `src/auto24_service/browser_chromium.py`, `tests/fakesite/extension.py`
- Modify: `pyproject.toml` (the `chromium` optional extra lists `patchright==1.64.1`; the image installs it from the hashed file)
- Test: `tests/test_chromium_browser.py`

**Interfaces:**
- Consumes: Task 5's `ListingSession` fields and guard, `browser._navigate`, and the Task 4 findings.
- Produces, in `browser_chromium`:
  - `CHROMIUM_FLAGS: tuple[str, ...]`, which turns off background traffic as listed in the spec.
    - It includes `--force-webrtc-ip-handling-policy=default_public_interface_only`, `--disable-background-networking`, `--disable-component-update`, `--disable-sync`, `--dns-prefetch-disable`, `--no-pings`, `--disable-client-side-phishing-detection`, `--disable-field-trial-config`, `--disable-dev-shm-usage`, `--no-first-run`, `--no-default-browser-check`, `--password-store=basic` and `--use-mock-keychain`.
    - The offline sandbox decides additions.
  - `PROFILE_ROOT = Path("/tmp/auto24-chromium")`. Every temporary profile is `mkdtemp(dir=PROFILE_ROOT, prefix="profile-")`.
  - `EXTENSION_READY_SECONDS = 5.0`
  - `parse_headless(value: str | None) -> bool`: `None` or `""` gives False; `true`/`false` after strip and casefold; anything else raises `ValueError`.
  - `extension_id_from_manifest(extension_dir: Path) -> str`: the same derivation as Task 2, read from `manifest.json`'s `key`.
  - `open_chromium_listing(url, *, setup=None, profile_dir=None, deadline=None, extension_dir=None, executable=None, headless=None) -> ContextManager[ListingSession]`
    - It has the same contract as `browser.open_listing`, and yields a session with `engine="chromium"`, `extension_id`, and `extension_loaded=True`.
    - Defaults come from `CAPTCHARAPTOR_DIR`, `CHROMIUM_EXECUTABLE` and `CHROMIUM_HEADLESS`.
    - It raises `CaptureError("browser_launch")` when Xvfb or Chromium fails to start, and `CaptureError("extension_not_loaded")` when readiness fails.
    - This task closes the browser and stops Xvfb on a normal exit. Task 9 covers every other path.
- Produces, in `tests/fakesite/extension.py`:
  - `TEST_EXTENSION_KEY: str`, a second committed public key.
  - `write_test_extension(dest: Path, *, behavior: Literal["solve", "idle", "no_worker", "probe_fails"] = "solve", picks: tuple[int, ...] = (0, 4, 8)) -> Path`. The extension it writes:
    - has a content script on `https://www.google.com/recaptcha/*` with `all_frames`;
    - with `solve`, clicks `#recaptcha-anchor`, clicks `picks` in `td.rc-imageselect-tile`, then `#recaptcha-verify-button`, and repeats on each new grid;
    - with `idle`, does nothing;
    - has a background worker defining `self.queryPhash`, except with `no_worker` (no background) and `probe_fails` (it throws);
    - has a CSP of `connect-src 'self'`.

- [ ] **Step 1: Write the failing tests.** Skip rules are in "Running tests".
  - `test_fake_listing_opens_with_the_extension_ready`: `install_fake_site` via `setup` and `Scenario(captcha="none")`. `session.engine == "chromium"`, `session.extension_loaded is True`, and the page shows `.field-reg_nr`.
  - `test_missing_worker_fails_with_extension_not_loaded`: `behavior="no_worker"` gives `CaptureError.code == "extension_not_loaded"` within 6 s.
  - `test_wrong_extension_id_fails_with_extension_not_loaded`: monkeypatch `extension_id_from_manifest` to return another valid ID.
  - `test_failing_probe_fails_with_extension_not_loaded`
  - `test_readiness_never_outlives_the_deadline`: `deadline=time.monotonic() + 2` with `no_worker` raises within 3 s (Review Focus 3).
  - `test_worker_started_before_listening_is_found`: wrap `context.wait_for_event` so it would time out. Readiness must still pass from `context.service_workers`.
  - `test_bad_executable_fails_with_browser_launch`
  - Negative guard tests:
    - `test_page_fetch_to_a_foreign_host_is_blocked`: `fetch("https://example.invalid/x")` rejects, and `"example.invalid/x/"` is in `session.blocked`.
    - `test_website_cannot_register_a_service_worker`
    - `test_real_extension_worker_cannot_fetch_a_foreign_host`: needs `CAPTCHARAPTOR_DIR`. In the real extension's worker, `fetch("https://example.invalid/")` rejects with a CSP violation, and the guard log shows no such request.
  - `test_headless_flag_values`
- [ ] **Step 2:** Run `PYTEST_SERVICE_IMAGE=auto24-extraction-service:chromium scripts/pytest-service tests/test_chromium_browser.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Xvfb: `Xvfb -displayfd <fd> -nolisten tcp -screen 0 1920x1080x24` with `start_new_session=True`, and `AUTO24_CHROMIUM=1` in its environment. Read the display number from the fd.
  - Launch `patchright.sync_api.sync_playwright().chromium.launch_persistent_context` with:
    - `user_data_dir`, `executable_path`;
    - `headless=False`, with `--headless=new` added to the flags instead when headless is on;
    - `args=[*CHROMIUM_FLAGS, --load-extension=<dir>, --disable-extensions-except=<dir>]`;
    - `service_workers="block"`, `no_viewport=True`, `env` with `DISPLAY`;
    - `timeout=min(30000, remaining)`.
  - Readiness:
    - Check `context.service_workers` first, then `context.wait_for_event("serviceworker", timeout=...)`. Accept only `url.startswith(f"chrome-extension://{id}/")`.
    - Then evaluate `self.queryPhash({imgtype: 33, name: "readiness", phash: "0000000000000000"}).then(r => Array.isArray(r))` in that worker.
    - The whole check is bounded by `min(EXTENSION_READY_SECONDS, deadline - now)`.
  - Navigate with `browser._navigate`, so the guard, redirects and status codes behave exactly as on Camoufox.
- [ ] **Step 4:** Run the tests in the Chromium image. Expected: PASS, with no skips.
- [ ] **Step 5:** Commit: `feat: launch ungoogled-chromium with the local extension and check it is ready`.

### Task 7: Sandbox, compose and docs plumbing

Role: small implementation changes and focused tests. Parallel with Task 6, on separate files.

**Files:**
- Modify: `scripts/network-sandbox`, `compose.sandbox.yaml`, `tests/test_compose_contract.py`, `docs/local-development.md` (a "Chromium engine" section: fetch, build, run, sandbox, demo, and the version-bump procedure from the spec's "Updates" decision), `.gitignore` (`demo-output/`)
- Create: `compose.chromium.yaml`

**Interfaces:**
- Produces:
  - `scripts/network-sandbox offline|live ... [--engine camoufox|chromium]` exports `SANDBOX_BASE_IMAGE` and `CAPTURE_ENGINE`. Offline on Chromium runs the glob from "Running tests".
  - `compose.sandbox.yaml` `capture.build` gets `args: {BASE_IMAGE: ${SANDBOX_BASE_IMAGE:-auto24-extraction-service:compose}}`, the inline Dockerfile uses `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}`, and the environment gets `CAPTURE_ENGINE: ${CAPTURE_ENGINE:-camoufox}`.
  - `compose.chromium.yaml` overrides `worker` with `image: auto24-extraction-service:chromium`, `pull_policy: never`, `build: !reset null`, `environment: {CAPTURE_ENGINE: chromium, CHROMIUM_HEADLESS: ${CHROMIUM_HEADLESS:-false}}` and `user: capture`.

- [ ] **Step 1: Write the failing tests.**
  - `test_chromium_override_only_changes_the_worker`: the override's services are `{"worker"}`, its environment sets `CAPTURE_ENGINE`, and it has no `ports`.
  - `test_sandbox_capture_base_image_is_configurable`
  - `test_sandbox_capture_still_cannot_reach_the_traffic_log`: the existing check, run on the edited file.
- [ ] **Step 2:** Run `python -m pytest tests/test_compose_contract.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and `scripts/network-sandbox offline` (Camoufox). Expected: PASS.
- [ ] **Step 5:** Commit: `build: let the network sandbox and compose run the Chromium image`.

### Task 8: Demo command

Role: small implementation changes and focused tests. Starts after Task 6 merges.

**Files:**
- Create: `scripts/chromium-demo` (a shell wrapper: `docker run` on the Chromium image, `--network none`, mounting `./demo-output`), `scripts/chromium-demo.py`
- Test: `tests/test_chromium_demo.py`

**Interfaces:**
- Consumes: `open_chromium_listing`, `install_fake_site`, `Scenario`, `write_test_extension`.
- Produces: `scripts/chromium-demo [--scenario none|checkbox_only|challenge] [--grid 3x3|4x4] [--extension real|test-solve|test-idle|test-no-worker] [--reveal] [--headless] [--repeat N]`.
  - It prints `engine:`, `extension id:`, `extension_loaded:`, the field statuses, and one line per attempt in the format of `sandbox-live-capture.format_attempts`.
  - After each run it prints `leftover processes: <n>` and `leftover profiles: <n>`, counted under `PROFILE_ROOT`.
  - It saves `demo-output/listing.png` and, with `--reveal`, `demo-output/after-reveal.png`.
  - Until Task 13, `--reveal` exits 2 with `reveal is not available yet`. Task 13 makes it click the trigger and wait for the real extension. Task 15 makes it run the full Plan A reveal.

- [ ] **Step 1: Write the failing test.** `test_demo_prints_engine_and_extension_id` runs `main([...])` and reads stdout.
- [ ] **Step 2:** Run it in the Chromium image. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the test and the CP3 "How to check" steps 1 to 3. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add a Chromium demo on the fake listing`.

### CP3 close-out

- [ ] Reviews in parallel. Merge 7, then 6, then 8.
- [ ] Run `scripts/network-sandbox offline --engine chromium`. Any Chromium background traffic it records goes into `CHROMIUM_FLAGS` as a follow-up fix in Task 6's area, and then it runs again.
- [ ] The coordinator writes the CP3 checkpoint note and stops for the user.

---

# CP4: Capture on Chromium end to end

This finishes the spec's C1.

## What you will see

With `CAPTURE_ENGINE=chromium`, a job submitted on the API docs page completes with the same listing data as a Camoufox capture. Its diagnostics show `engine: chromium` and `extension_loaded: true`. No reveal runs yet. No Chromium or Xvfb process is left between jobs, and a worker killed mid-job leaves nothing behind after it restarts.

## How to check

1. Start the stack with `docker compose -f compose.yaml -f compose.chromium.yaml up -d`. Submit a listing on the API docs page. Confirm `completed`, `engine: chromium` and `extension_loaded: true`, and compare the facts with a Camoufox capture of the same listing.
2. Submit two more listings. Between jobs, run `docker compose exec worker sh -c 'ps -eo cmd | grep -cE "[c]hrome|[X]vfb"; ls /tmp/auto24-chromium | wc -l'` and confirm `0` and `0`.
3. Submit a listing, run `docker compose kill worker` while it is capturing, then `docker compose up -d worker`. Confirm that step 2's command prints `0` and `0`, and that the job retries and completes.
4. Run `scripts/chromium-demo --repeat 3`. Confirm `leftover processes: 0` and `leftover profiles: 0` after each run.
5. Run `scripts/network-sandbox live --url <listing> --engine chromium`. Confirm only `www.auto24.ee`, `www.google.com` and `www.gstatic.com`.
6. Set `CAPTURE_ENGINE=firefox` and start the worker. Confirm it stops at startup with an error naming `CAPTURE_ENGINE`.

### Task 9: Cleanup on every exit path

Role: integration, database work, and debugging. Parallel with Task 10, and merges before it.

**Files:**
- Modify: `src/auto24_service/browser_chromium.py`
- Test: `tests/test_chromium_cleanup.py`

**Interfaces:**
- Produces:
  - `cleanup_leftovers(root: Path = PROFILE_ROOT) -> None`: kills every process group whose `/proc/<pid>/cmdline` contains `root`, kills any process with `AUTO24_CHROMIUM=1` in `/proc/<pid>/environ` (our Xvfb), and deletes everything under `root`.
  - `_close(context, xvfb, profile: Path | None, temporary: bool)`: closes the context, `os.killpg` on any process whose cmdline has `--user-data-dir=<profile>`, stops Xvfb, and deletes the profile when `temporary`. It never raises.

- [ ] **Step 1: Write the failing tests.** Each asserts afterwards that no process has the profile path in its cmdline, that the Xvfb pid is gone, and that the temporary profile folder no longer exists.
  - `test_normal_close_cleans_up`
  - `test_launch_failure_cleans_up`
  - `test_readiness_failure_cleans_up`
  - `test_timeout_during_navigation_cleans_up`
  - `test_crash_mid_session_is_cleaned_and_next_launch_works`: `os.kill` the browser process inside the `with`, then open a second session successfully (Review Focus 2).
  - `test_exception_inside_the_session_cleans_up`
  - `test_cleanup_leftovers_after_a_killed_worker`: start a session in a subprocess, `SIGKILL` the subprocess, then `cleanup_leftovers()` leaves no Chromium, no Xvfb and an empty root.
  - `test_two_captures_in_a_row_leave_nothing_behind`: the two sessions get different displays and profiles (Review Focus 1).
- [ ] **Step 2:** Run them in the Chromium image. Expected: FAIL where cleanup is missing.
- [ ] **Step 3: Implement.** Put `_close` in a `finally` that wraps everything after Xvfb starts.
- [ ] **Step 4:** Run `tests/test_chromium_cleanup.py tests/test_chromium_browser.py` in the Chromium image. Expected: PASS.
- [ ] **Step 5:** Commit: `fix: clean up Chromium, Xvfb and the profile on every exit path`.

### Task 10: Engine selection and capture wiring

Role: integration, database work, and debugging. Parallel with Task 9. It calls `browser_chromium.cleanup_leftovers`, so it rebases on Task 9 before merging.

**Files:**
- Modify:
  - `src/auto24_service/worker.py` (`main`, `_fail`)
  - `src/auto24_service/browser.py` (`capture_listing`: `solver: SolverLike | None`, engine fields copied into diagnostics)
  - `src/auto24_service/contracts.py` (`RevealDiagnostics`)
  - `src/auto24_service/captcha/reveal.py` (adds `skip_reveal`)
  - `src/auto24_service/captcha_benchmark.py` (registers the Chromium opener)
  - `scripts/sandbox-live-capture.py`
- Test: `tests/test_worker.py`, `tests/test_contracts.py`, `tests/test_chromium_browser.py`, `tests/test_live_capture_script.py`, `tests/test_captcha_benchmark.py`

**Interfaces:**
- Consumes: `open_chromium_listing`, `cleanup_leftovers`, `parse_headless`.
- Produces:
  - `RevealDiagnostics.engine: Literal["camoufox", "chromium"] = "camoufox"` and `RevealDiagnostics.extension_loaded: bool | None = None`.
  - `worker.parse_capture_engine(value: str | None) -> Literal["camoufox", "chromium"]`: strip and casefold; `None` or `""` gives `camoufox`; anything else raises `ValueError`.
  - `worker.main` on Chromium calls `cleanup_leftovers()` first and skips solver verification and loading. It uses `capture = partial(capture_listing, solver=None, opener=open_chromium_listing, reveal=skip_reveal)`. `CHROMIUM_HEADLESS` is parsed at startup.
  - `_fail(client, claim, code, cause: str | None = None)` logs `cause=<CaptureError.code>`.
  - `reveal.skip_reveal(first, reopen, solver, **_) -> RevealOutcome`: hidden and rejected fields become `unavailable`, with `attempts=[]`.
  - `capture_listing` sets `diagnostics.engine` and `diagnostics.extension_loaded` from the session. This includes the `_reveal_crashed` path.
  - `sandbox-live-capture.py` picks its opener from `CAPTURE_ENGINE`.
  - The benchmark's `chromium` engine now works. Delete `test_chromium_engine_unavailable_exits_2`.

- [ ] **Step 1: Write the failing tests.**
  - `test_capture_engine_values` (Review Focus 5): `" Chromium "` gives `chromium`; `None` gives `camoufox`; `"firefox"` raises.
  - `test_worker_stops_at_startup_on_an_unknown_engine`: `main([])` with `CAPTURE_ENGINE=firefox` exits through `argparse` error 2.
  - `test_chromium_worker_does_not_load_the_python_solver`: monkeypatch `load_solver` to raise. `main(["--once"])` with `CAPTURE_ENGINE=chromium` and a fake `StorageClient` that has no job returns 0.
  - `test_unknown_capture_error_is_logged_with_its_cause`: `caplog` contains `code=temporary_failure` and `cause=extension_not_loaded`.
  - `test_chromium_capture_without_hidden_fields_reports_engine` (Review Focus 4, Chromium image): `Scenario(reg="full", vin="full", captcha="none")` gives `diagnostics.engine == "chromium"`, `extension_loaded is True` and `attempts == []`.
  - `test_chromium_capture_runs_no_reveal_yet`: on `Scenario()`, both statuses are `unavailable`, no `data_json.php` request carries `q=uv_`, and `engine == "chromium"`.
  - `test_reveal_diagnostics_default_to_camoufox`: an old payload with no `engine` validates with `engine == "camoufox"`.
- [ ] **Step 2:** Run them in their images. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the full Python suite in both images, both offline sandboxes, and the CP4 "How to check" steps 4 and 6. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: select the capture engine with CAPTURE_ENGINE`.

### CP4 close-out

- [ ] Independent code review of the C1 diff (CP1 to CP4).
- [ ] Final review of privacy and concurrency (role: final review of migrations, privacy, or concurrency): the guard gaps table, cleanup paths and process kills, and that no values reach the logs.
- [ ] The coordinator writes the CP4 checkpoint note and stops for the user.

---

# CP5: The real extension on fake grids

## What you will see

The real CaptchaRaptor build, running under Patchright in Docker, opens the fake reCAPTCHA, loads its models, picks tiles and presses verify on a 3x3 and a 4x4 grid, on arm64 and on x86_64. Screenshots show the selected tiles. The round tracker's tests show how replies become rounds.

## How to check

1. Run `scripts/chromium-demo --extension real --scenario challenge --grid 3x3 --reveal`. Open `demo-output/after-reveal.png` and confirm selected tiles on the fake grid. Confirm the printed `verify pressed: yes` and `extension files loaded: type.onnx grid.onnx ort-wasm ... sql-wasm.wasm`.
2. Repeat with `--grid 4x4`.
3. Run `PYTEST_SERVICE_IMAGE=auto24-extraction-service:chromium scripts/pytest-service tests/test_captcharaptor_smoke.py -v`, then again with `PYTEST_SERVICE_PLATFORM=linux/amd64`. Confirm 2 passed both times.
4. Run `python -m pytest tests/test_extension_rounds.py -v`. Confirm each named case passes, among them `test_repeated_reply_for_the_same_challenge_is_one_round_and_not_progress`.

### Task 11: Plan A contract fields and fake challenge IDs

Role: small implementation changes and focused tests. Runs first in CP5.

**Files:**
- Modify: `src/auto24_service/contracts.py`, `tests/fakesite/__init__.py`
- Test: `tests/test_contracts.py`, `tests/test_fakesite.py`

**Interfaces:**
- Produces:
  - `AttemptRecord.solver` and `RoundRecord.solver`: `Literal["python", "extension"] = "python"`.
  - `RoundRecord.grid`: `Literal["3x3", "3x3_dynamic", "4x4"] | None`.
  - `RoundRecord.incomplete: bool = False`.
  - `AttemptStage` gains `"stall"`.
  - `Scenario.challenge_ids: bool = False`. When it is True:
    - reload bodies are `["rresp", f"chal-{n}", None, 120, pmeta, kind]`, with `n` counting reloads;
    - an inline incorrect reply is `["uvresp", None, None, None, ["rresp", f"chal-{n}", None, 120, pmeta, kind]]`.
  - The default fake replies are unchanged, so Plan B tests do not move.

- [ ] **Step 1: Write the failing tests.**
  - `test_old_records_read_as_python_solver`
  - `test_extension_round_without_grid_validates`: `grid=None, tiles=[], tiles_clicked=[], solver="extension"`.
  - `test_challenge_ids_scenario_numbers_reloads`: two reloads carry `chal-1` and `chal-2`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `tests/test_contracts.py tests/test_fakesite.py tests/test_captcha_driver.py tests/test_reveal.py`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add solver, stall and incomplete fields for the extension reveal`.

### Task 12: Round tracker

Role: small implementation changes and focused tests. Parallel with Task 13, after Task 11.

**Files:**
- Create: `src/auto24_service/captcha/extension_rounds.py`
- Test: `tests/test_extension_rounds.py`. This is pure Python and needs no browser.

**Interfaces:**
- Produces:
  - `RoundTracker(clock: Callable[[], float])`
  - `.on_reply(kind: Literal["reload", "payload", "replaceimage", "userverify"], body: str) -> bool`: True means progress.
  - `.rounds: list[RoundRecord]`: every round has `solver="extension"`, `tiles=[]` and `tiles_clicked=[]`.
  - `.ended_without_pass: int`
  - `.close(result: Literal["solved", "timeout", "try_again_later"]) -> None`: ends the open round.
- The rules:
  - A round is keyed by challenge ID: `rresp[1]` in `reload`, or the first nested list starting with `"rresp"` in `userverify`. An ID already seen is the same round.
  - `payload` and `replaceimage` while a round is open count as progress. A dynamic 3x3 refill stays in the same round.
  - A `userverify` reply ends the open round: `incorrect` without a token, `solved` with one. The caller's tick check overrides the result.
  - Grid and label come from `recaptcha._challenge_parts`.
  - A body that `_google_json` cannot read, or a `reload` or `userverify` with no recognisable ID, sets the open round's `incomplete=True` and is not progress. It never raises.

- [ ] **Step 1: Write the failing tests,** with literal bodies like the fake site's:
  - `test_reload_starts_a_round_with_grid_and_label`
  - `test_repeated_reply_for_the_same_challenge_is_one_round_and_not_progress`
  - `test_dynamic_refill_payloads_stay_in_the_round_and_count_as_progress`
  - `test_userverify_without_token_ends_the_round_incorrect`
  - `test_inline_next_challenge_in_userverify_starts_the_next_round`
  - `test_unknown_reply_marks_incomplete_and_never_raises`: covers `")]}'\n{"`, `[]` and `["rresp"]`.
  - `test_ended_without_pass_counts_rounds`
- [ ] **Step 2:** Run `python -m pytest tests/test_extension_rounds.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: count extension reCAPTCHA rounds from Google's replies`.

### Task 13: Real-extension smoke test

Role: integration, database work, and debugging. Parallel with Task 12, after Task 11.

**Files:**
- Modify: `tests/fakesite/__init__.py` and `tests/fakesite/pages/bframe.html`, only as far as the real content script needs, behind a `Scenario.real_dom: bool = False` flag so the existing tests keep their pages. Also `scripts/chromium-demo.py`, which gets the `verify pressed:` and `extension files loaded:` lines, and lets `--reveal` with `--extension real` run the trigger click and wait.
- Test: `tests/test_captcharaptor_smoke.py`

**Interfaces:**
- Consumes: the built extension in `CAPTCHARAPTOR_DIR`, and `open_chromium_listing` with its default extension.

- [ ] **Step 1: Write the failing tests.**
  - `test_real_extension_submits_an_answer_on_a_3x3_grid`
  - `test_real_extension_submits_an_answer_on_a_4x4_grid`

  Each opens the fake listing with `Scenario(real_dom=True, grid=..., challenge_ids=True)`, clicks the trigger, and waits up to 60 s. It asserts:
  - `log.verifies >= 1`;
  - the extension's own files were requested: `type.onnx`, `grid.onnx`, the onnxruntime `.wasm`, and `sql-wasm.wasm` or the sqlite file. Collect these with `context.on("request")` filtered to `chrome-extension://<EXTENSION_ID>/`; where routing cannot see them, confirm with a `performance.getEntriesByType("resource")` read in the bframe.

  The images are synthetic, so the test does not check correctness.
- [ ] **Step 2:** Run them in the Chromium image. Expected: FAIL until the fake DOM is close enough.
- [ ] **Step 3: Implement.** Read the pinned `captcha/recaptcha.js` and `recaptcha_ai.js` in `/opt/captcharaptor`. Add only the selectors, attributes and image URLs they read. Do not edit the extension.
- [ ] **Step 4:** Run both on arm64, and on `linux/amd64`. Expected: PASS on both. A failure on either architecture blocks CP5 and is reported (see Decisions, Patchright).
- [ ] **Step 5:** Commit: `test: smoke-test the real extension on fake 3x3 and 4x4 grids`.

### CP5 close-out

- [ ] Reviews of Tasks 12 and 13 in parallel. Merge 11, then 12, then 13.
- [ ] The coordinator writes the CP5 checkpoint note and stops for the user.

---

# CP6: Registration number and VIN revealed on Chromium

## What you will see

On the fake site and on a real listing, a Chromium job returns the revealed registration number and VIN, and each attempt and round says `solver: extension`. An extension that does nothing ends its attempt after about 20 s at stage `stall`, and the retry still starts.

## How to check

1. Run `scripts/chromium-demo --extension test-solve --scenario challenge --reveal`. Confirm `reg_number_status: revealed`, `vin_status: revealed`, and `solver=extension` on the attempt line. Open `demo-output/after-reveal.png` and confirm both values are shown on the fake page.
2. Run `scripts/chromium-demo --extension test-idle --scenario challenge --reveal`. Confirm attempt 1 `reason=timeout stage=stall` at about 20 s, followed by an attempt 2 line.
3. Run `scripts/network-sandbox live --url <listing with hidden values> --engine chromium`. Confirm both statuses are `revealed`, the attempt says `solver=extension`, and only the three hosts are listed.
4. With the Chromium stack running, submit the same listing on the API docs page. Confirm `revealed` for both values, compare them with the listing in your own browser, and confirm `solver: extension` in the diagnostics.

### Task 14: Injectable solve step in the reveal

Role: small implementation changes and focused tests. Parallel with Task 15, and merges first.

**Files:**
- Modify: `src/auto24_service/captcha/reveal.py` (`reveal_registration`, `_Attempt.solve`, `_run_attempt`)
- Test: `tests/test_reveal.py` (Camoufox image)

**Interfaces:**
- Produces:
  - `reveal_registration(..., solve=solve_recaptcha, solver_kind: Literal["python", "extension"] = "python")`. `_Attempt.solve` calls `solve` with the same arguments `solve_recaptcha` gets today. `_run_attempt` stamps `solver=solver_kind` on the `AttemptRecord`.

- [ ] **Step 1: Write the failing tests.**
  - `test_injected_solve_is_called_instead_of_the_driver`: a fake `solve` that returns `CaptchaResult(True, None, True)` reveals both values on `Scenario(captcha="checkbox_only")` without the driver clicking the checkbox, so the fake log shows no anchor click from Python.
  - `test_solver_kind_is_stamped_on_attempts`
  - `test_default_reveal_is_unchanged`: the whole existing `tests/test_reveal.py` passes.
- [ ] **Step 2:** Run `scripts/pytest-service tests/test_reveal.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `tests/test_reveal.py tests/test_captcha_driver.py`. Expected: PASS.
- [ ] **Step 5:** Commit: `refactor: let the reveal take its solve step as an argument`.

### Task 15: Extension solve watcher and the Plan A reveal

Role: integration, database work, and debugging. Parallel with Task 14. Its integration tests run after rebasing on Task 14.

**Files:**
- Create: `src/auto24_service/captcha/extension_solve.py`
- Modify: `src/auto24_service/worker.py`, `scripts/sandbox-live-capture.py` (prints `solver=` per attempt), `scripts/chromium-demo.py`
- Test: `tests/test_chromium_reveal.py`

**Interfaces:**
- Consumes: `RoundTracker`. For page signals it reuses `recaptcha._Driver`, built with `solver=None` and never `run()`: `on_response`, `arm_tick_watch`, `anchor_checked`, `try_again_later` and `challenge_visible`.
- Produces:
  - `watch_extension_solve(page, solver, *, deadline, rounds_left, clock=time.monotonic, rng=None, save_image=None, debug=None) -> CaptchaResult`. The signature matches `solve_recaptcha`. It never clicks. It ends with one of:
    - a pass on a tick, with `checkbox_only` True when no challenge was ever shown;
    - `widget_gone` when the anchor frame leaves without a tick;
    - `try_again_later`;
    - `captcha_rounds_exhausted` once `ended_without_pass >= rounds_left`;
    - `timeout` with `stage="stall"` after 20 s without progress;
    - `timeout` at the deadline.
  - Progress is only a new round, new tile images, or the checkbox ticking. The value appearing is checked by `reveal`.
  - `reveal_with_extension = functools.partial(reveal_registration, solve=watch_extension_solve, solver_kind="extension")`
  - The worker and the demo on Chromium use `reveal=reveal_with_extension` instead of `skip_reveal`.

- [ ] **Step 1: Write the failing tests.** They run in the Chromium image with `write_test_extension` and `Scenario(challenge_ids=True)`:
  - `test_extension_reveals_both_values_on_a_challenge`: both statuses are `revealed`, `attempts[0].solver == "extension"`, every round has `solver == "extension"` and `tiles == []`, and the revealed values do not appear in `diagnostics.model_dump_json()`.
  - `test_checkbox_only_pass_reveals_without_rounds`
  - `test_idle_extension_stalls_after_20_seconds_and_retry_still_fits`: attempt 1 gives `reason == "timeout"` and `stage == "stall"` in under 25 s, and attempt 2 is started.
  - `test_three_incorrect_rounds_exhaust_the_attempt`: `incorrect_rounds=5` gives `captcha_rounds_exhausted` with 3 rounds.
  - `test_repeated_replies_do_not_reset_the_stall_timer`: a page that re-posts the same reload every 2 s still stalls at 20 s.
  - `test_try_again_later_is_reported`
  - `test_chromium_crash_during_reveal_is_unavailable_and_job_completes`: `capture_listing` returns, with `reason == "browser_error"` on attempt 1.
  - `test_value_failing_json_check_is_rejected`
  - `test_widget_removed_after_pass_still_reveals`: `verify_vanish="with_value"`.
  - `test_debug_screenshots_mask_values_on_chromium`: reuse the existing Camoufox masking assertion with a `DebugRecorder`.
- [ ] **Step 2:** Run them in the Chromium image. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** After rebasing on Task 14, run `tests/test_chromium_reveal.py`, `tests/test_reveal.py` and `tests/test_captcha_driver.py` in their images, and the CP6 "How to check" steps 1 and 2. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: reveal with the local extension on Chromium`.

### CP6 close-out

- [ ] Reviews in parallel. Merge 14, then 15.
- [ ] Final review of privacy and concurrency: the reveal thread on Chromium, and that no values reach diagnostics, logs or screenshots.
- [ ] The coordinator writes the CP6 checkpoint note and stops for the user.

---

# CP7: The engine benchmark

## What you will see

One benchmark run compares `camoufox/fresh`, `chromium/fresh` and `chromium/shared` side by side, with attempt-1 and retry passes, rounds, timings and the `no_captcha_needed` count. Shared mode keeps one browser for the whole run and opens each listing in a new tab.

## How to check

1. On the Mac, run the benchmark in the Chromium image with `--engine both --mode fresh shared --reveals 2` on two listings. Confirm three sections, `skipped_combinations: ['camoufox/shared']`, and `deciding_combination: None`.
2. Watch the progress lines during the shared part. Confirm the listings open in one browser: the shared section reports `browser launches: 1`, plus one more for each retry.
3. Confirm `chromium/shared` reports how many reveals needed no CAPTCHA.

### Task 16: Shared browser and benchmark wiring

Role: integration, database work, and debugging.

**Files:**
- Modify: `src/auto24_service/browser_chromium.py` (shared browser), `src/auto24_service/browser.py` (`capture_listing` gains `reopener`), `src/auto24_service/captcha_benchmark.py`, `docs/local-development.md`
- Test: `tests/test_chromium_browser.py`, `tests/test_captcha_benchmark.py`

**Interfaces:**
- Produces:
  - `open_chromium_browser(*, profile_dir=None, extension_dir=None, executable=None, headless=None) -> ContextManager[ChromiumBrowser]`.
    - `ChromiumBrowser.open_listing(url, *, setup=None, profile_dir=None, deadline=None) -> ContextManager[ListingSession]` opens a new tab and closes it afterwards.
    - One context-level guard is installed at browser start. Its blocked entries go to the tab session that is currently open.
    - Readiness runs once, at browser start. `ChromiumBrowser.launches` counts browser starts for the report.
  - `capture_listing(..., reopener=None)`: attempt 2 uses `reopener or opener`. Shared mode passes `reopener=open_chromium_listing`.
  - The benchmark's `chromium/shared` uses one `ChromiumBrowser` for the whole combination and reports `browser_launches`.

- [ ] **Step 1: Write the failing tests.**
  - `test_shared_browser_opens_each_listing_in_a_new_tab` (Chromium image): two `open_listing` calls on one `ChromiumBrowser` show one browser process and two tabs opened and closed, and a cookie set by the fake site in tab 1 is visible in tab 2.
  - `test_shared_retry_uses_a_fresh_browser`
  - `test_shared_mode_deletes_its_profile_at_the_end_of_the_run`
  - `test_shared_combination_reports_browser_launches`: with fake openers.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the full Python suite in both images, and `scripts/network-sandbox offline --engine chromium`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add a shared-browser mode to the Chromium benchmark`.

### CP7 close-out

- [ ] Independent code review of the C2 diff (CP5 to CP7).
- [ ] Final review of privacy and concurrency: the shared browser's guard and tab sessions, and that no values reach reports.
- [ ] The coordinator writes the CP7 checkpoint note and stops for the user.

---

## After CP7: your gate runs

These are yours. They follow the spec's gate.

1. On your `x86_64` server, run the benchmark with `--engine both --mode fresh shared` on your 10 listings. Confirm that `chromium/fresh` passes 8 of 10 or better, counting capture errors as failures.
2. Repeat until `chromium/fresh` has passed 3 runs in a row.

If `chromium/fresh` fails the gate, stop and decide between CloakBrowser (after an audit like the CaptchaRaptor one) and staying on Plan B.
