# Chromium Extension Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second capture engine, ungoogled-chromium driven by Patchright with the local CaptchaRaptor extension, behind `CAPTURE_ENGINE`, and benchmark it against Camoufox.

**Architecture:** The capture and retry opener contracts are owned by [`opener.py`](../../../src/auto24_service/opener.py); Chromium supplies `CHROMIUM_OPENER` so the capture and reveal code stay shared. The reveal gets one new solving mode, `captcha/extension_wait.py`, that watches the extension solve instead of driving the widget. A new image, `Dockerfile.chromium`, carries the pinned browser for both architectures, Xvfb and the built extension.

**Tech Stack:** Python 3.12, Patchright (sync API), ungoogled-chromium 155.0.8059.84-1 Linux builds, Xvfb (Debian), Docker buildx (`linux/amd64`, `linux/arm64`), pytest.

**Spec:** `docs/superpowers/specs/2026-10-19-chromium-extension-engine-design.md`

## Global Constraints

- Agents run no live captures, no live sandbox and no benchmark. The user runs them. Agents may run offline tests and `scripts/network-sandbox offline`.
- No real plates or VINs in code, tests, docs, commits or chat. Fake values only (`123ABC`, `WVWZZZ1KZAW000001`).
- No new outbound hosts. Page guard: main frame `www.auto24.ee`; subresources `www.auto24.ee` plus `https://www.google.com/recaptcha/` and `https://www.gstatic.com/recaptcha/`; on Chromium also `chrome-extension://<our id>/`.
- Every downloaded input is pinned by SHA-256 in `vendor/browser-assets/SHA256SUMS`. A mismatch fails the fetch and the image build.
- ungoogled-chromium `155.0.8059.84-1`, archives `ungoogled-chromium-155.0.8059.84-1-x86_64_linux.tar.xz` and `ungoogled-chromium-155.0.8059.84-1-arm64_linux.tar.xz`. Patchright at one exact version, installed with `--require-hashes`, never using its own browser download.
- `CAPTURE_ENGINE=camoufox|chromium`, default `camoufox`; any other value stops the worker. `CHROMIUM_HEADLESS=true` switches to `--headless=new`; the default is Xvfb.
- Xvfb starts with `-nolisten tcp`.
- Readiness check: at most 5 s and never past the lease. Stall cap: 20 s without progress. Attempt cap 90 s and 3 rounds, unchanged.
- New contract fields are additive with defaults; older records without `solver` read as `"python"`.
- Ask the user before pushing. No AI attribution lines in commits. No em dashes in docs or commits.
- Python tests that need no browser run in `auto24-extraction-service:sandbox` with `--network none`. Chromium tests run in the `test` target of `Dockerfile.chromium` with `--network none`.

## Review Focus

1. Worker killed (SIGTERM) in the middle of a capture: Chromium, Xvfb and the profile must not survive into the next start. Test in Task 4 (`test_startup_sweeps_leftovers_from_a_killed_worker`).
2. Lease nearly spent when the browser launches: readiness must fail fast as `extension_not_loaded` or `temporary_failure`, not run past the lease. Test in Task 4 (`test_readiness_never_waits_past_the_deadline`).
3. Two Chromium sessions at once (attempt 2 on its thread, benchmark `shared` mode tabs): no shared Xvfb display or profile. Test in Task 4 (`test_two_sessions_get_their_own_display_and_profile`).
4. The extension's MV3 service worker goes idle and restarts during an attempt: the reveal must still finish or fail with a real reason, not hang. Test in Task 7 (`test_worker_restart_during_attempt_does_not_hang`).
5. A listing with both values listed in full: the extension stays idle and the capture ends without a 20 s stall. Test in Task 7 (`test_listed_in_full_needs_no_wait`).

---

## Checkpoint C1: Auto24 capture on Chromium

### Task 1: Pin the browser pair and fetch the inputs

**Files:**
- Create: `scripts/fetch-browser-assets`
- Create: `vendor/browser-assets/SHA256SUMS`, `vendor/browser-assets/VERSIONS`
- Test: `tests/test_fetch_browser_assets.py`

**Interfaces:**
- Produces: `~/.cache/auto24/browser-assets/` holding the four inputs named in the spec's asset table. `VERSIONS` lines: `chromium=155.0.8059.84-1`, `patchright=<x.y.z>`, `captcharaptor=7462474d5fdfda5618becc9ac7a421de3ea69495`, `onnxruntime-web=1.22.0`. Later tasks read these.
- `BROWSER_ASSETS_SOURCE_DIR`, when set, makes the script copy from that folder instead of downloading (used by tests).

- [ ] **Step 1: Choose the Patchright version.** Find the newest Patchright release on PyPI whose bundled Chromium major is 155, or the closest below it. Record it in `VERSIONS`, with one comment line naming the Chromium revision Patchright was built for. Ask the user before downloading anything: name the files, sources and sizes.
- [ ] **Step 2: Fill `SHA256SUMS`** with the four archives. The CaptchaRaptor and onnxruntime-web values are the ones `build_extension.py` pins (`b778bf...`, `e29355...`). For Chromium, download both archives after the user approves, and take the hashes from those files.
- [ ] **Step 3: Write the failing tests** in `tests/test_fetch_browser_assets.py`. They run the script through `subprocess` with `HOME` set to `tmp_path` and `BROWSER_ASSETS_SOURCE_DIR` set to a fixture folder of four small files, with `SHA256SUMS` replaced by a fixture copy through `BROWSER_ASSETS_SUMS`.
  - `test_copies_and_verifies_each_input`: exit 0, stdout has four `verified:` lines, the files are in `$HOME/.cache/auto24/browser-assets/`.
  - `test_cached_verified_files_are_not_copied_again`: a second run leaves the files' mtimes unchanged.
  - `test_wrong_file_fails_and_leaves_nothing`: one source file changed gives exit 1, `does not match SHA256SUMS` on stderr, and the bad file is not in the cache.
  - `test_missing_file_fails`: exit 1, and stderr names the file.
- [ ] **Step 4: Run them and confirm they fail.** Run: `docker run --rm --network none -v "$PWD:/app:ro" -w /app -e PYTHONPATH=/app/src --entrypoint python auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider tests/test_fetch_browser_assets.py`. Expected: 4 failed.
- [ ] **Step 5: Write `scripts/fetch-browser-assets`** in the style of `scripts/fetch-captcha-solver`: bash with `set -euo pipefail`, `sha256sum` or `shasum -a 256`, a temp file per download moved into place only after its hash matches, and `curl -sSfL` from the spec's sources.
- [ ] **Step 6: Run the tests.** Expected: 4 passed.
- [ ] **Step 7: Commit.** `git add scripts/fetch-browser-assets vendor/browser-assets tests/test_fetch_browser_assets.py && git commit -m "build: pin and fetch the Chromium engine inputs"`

### Task 2: Chromium image

**Files:**
- Create: `Dockerfile.chromium`
- Modify: `compose.yaml` (add `worker-chromium` under profile `chromium`), `pyproject.toml` (optional dependency group `chromium = ["patchright==<x.y.z>"]`)
- Create: `vendor/browser-assets/patchright-requirements.txt` (hash-pinned)
- Test: `tests/test_compose_contract.py`

**Interfaces:**
- Consumes: Task 1's cache folder through `additional_contexts: browser_assets: ${HOME}/.cache/auto24/browser-assets`.
- Produces: image `auto24-extraction-service:chromium` with `/opt/ungoogled-chromium/chrome`, `/opt/captcharaptor-extension/` (built extension), `Xvfb` on `PATH`, and env `CHROMIUM_EXECUTABLE=/opt/ungoogled-chromium/chrome`, `CAPTCHARAPTOR_EXTENSION_DIR=/opt/captcharaptor-extension`. Target `test` adds `.[test]`.

- [ ] **Step 1: Write the failing compose tests:**
  - `test_chromium_worker_uses_the_chromium_image_and_assets`: `worker-chromium.image == "auto24-extraction-service:chromium"`, its `additional_contexts` has `browser_assets`, its environment has `CAPTURE_ENGINE: chromium`, and it is under profile `chromium`.
  - `test_chromium_worker_has_no_report_or_debug_mounts`: it mounts neither `/reports` nor `/debug`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write `Dockerfile.chromium`.** It uses the base `python:3.12-slim-bookworm` and takes `ARG TARGETARCH`, mapping `amd64` to `x86_64` and `arm64` to `arm64`.
  - It copies the matching archive and `SHA256SUMS`, runs `sha256sum -c --ignore-missing`, and unpacks to `/opt/ungoogled-chromium`.
  - It installs `xvfb`, `xauth` and the libraries `chrome` needs. Start from the current Dockerfile's list and add what `ldd /opt/ungoogled-chromium/chrome | grep "not found"` reports.
  - It runs `pip install --require-hashes -r vendor/browser-assets/patchright-requirements.txt` and then the project with `--no-deps`.
  - It runs `python3 -I scripts/captcharaptor/build_extension.py <captcharaptor tarball> <ort tarball> --out /opt/captcharaptor-extension`.
  - It runs `/opt/ungoogled-chromium/chrome --version`, so a missing library fails the build.
- [ ] **Step 4: Run the compose tests.** Expected: pass.
- [ ] **Step 5: Build both platforms.** Run: `docker buildx build -f Dockerfile.chromium --platform linux/arm64 --build-context browser_assets=$HOME/.cache/auto24/browser-assets --load -t auto24-extraction-service:chromium .`, then the same with `--platform linux/amd64` and tag `auto24-extraction-service:chromium-amd64`. Expected: both finish and print `Chromium 155.0.8059.84`.
- [ ] **Step 6: Commit.** `git commit -m "build: add the Chromium engine image for amd64 and arm64"`

### Task 3: Shared per-site allowlist

**Files:**
- Create: `src/auto24_service/guard.py`
- Modify: `src/auto24_service/browser.py` (use `guard.allowed_url`)
- Test: `tests/test_guard.py`, plus the existing `tests/test_browser.py`, which must pass unchanged

**Interfaces:**
- Produces: `SiteAllowlist` (frozen dataclass: `main_frame_hosts: frozenset[str]`, `subresource_hosts: frozenset[str]`, `subresource_prefixes: tuple[str, ...]`), `AUTO24: SiteAllowlist`, and `allowed_url(url: str, *, main_frame: bool, site: SiteAllowlist = AUTO24, extension_id: str | None = None) -> bool`. `blocked_entry(url: str) -> str` moves here unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `test_auto24_allowlist_matches_the_current_guard`: every case from `tests/test_browser.py`'s guard tests gives the same result through `guard.allowed_url`.
  - `test_extension_url_allowed_only_for_our_id`: `chrome-extension://<id>/models/type.onnx` is allowed with `extension_id=<id>` and refused for another id or with `extension_id=None`.
  - `test_extension_url_never_allowed_as_main_frame`.
  - `test_unsafe_paths_still_refused_in_extension_urls`: `..`, `%` and `\` are refused.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement `guard.py`** by moving `_allowed_url`, `_UNSAFE_PATH_PARTS`, `ALLOWED_SUBRESOURCE_*` and `_blocked_entry` from `browser.py`. Keep the names `browser.py` imports, so its behavior is unchanged.
- [ ] **Step 4: Run `tests/test_guard.py` and `tests/test_browser.py`.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "refactor: move the request guard into a per-site allowlist"`

### Task 4: Chromium launcher

**Files:**
- Create: `src/auto24_service/browser_chromium.py`
- Create: `tests/fixtures/stub-extension/` (`manifest.json`, `background.js`, `content.js`): a test-only stand-in that clicks the fake checkbox and answers the fake grid. Its background answers a `ready` probe.
- Test: `tests/test_browser_chromium.py` (Chromium image only, skipped elsewhere)

**Interfaces:**
- Consumes: `guard.allowed_url`, `guard.blocked_entry`, `browser.ListingSession`, `browser.CaptureError`, `browser._navigate`.
- Produces:
  - `extension_id_for_path(path: Path) -> str`: Chromium's unpacked-extension id, the first 32 hex digits of `sha256(str(path))` mapped `0-f` to `a-p`.
  - `open_chromium_listing(url, *, setup=None, profile_dir=None, deadline=None, extension_dir: Path | None = None, headless: bool | None = None) -> Iterator[ListingSession]`. A context manager with `open_listing`'s signature. `extension_dir` defaults to `CAPTCHARAPTOR_EXTENSION_DIR`, `headless` to `CHROMIUM_HEADLESS`.
  - `ListingSession` gains `extension_loaded: bool | None = None` (`None` on Camoufox).
  - `sweep_leftovers(root: Path) -> int`: kills processes and deletes profiles left by an earlier run, and returns how many it removed.
  - `CaptureError("browser_launch")` and `CaptureError("extension_not_loaded")`.

- [ ] **Step 1: Write the failing tests.** Use `tests/fakesite` through `setup=lambda ctx: install_fake_site(ctx, Scenario())` and the stub extension.
  - `test_extension_id_for_path_matches_chromium`: the id for `/opt/captcharaptor-extension` equals the id Chromium reports for the loaded worker URL.
  - `test_opens_the_fake_listing_with_the_extension_ready`: `session.extension_loaded is True` and `session.page.url` is the canonical listing URL.
  - `test_existing_worker_is_found_without_waiting`: with a stub whose worker starts before the check runs, readiness passes without calling `wait_for_event`. Spy on it.
  - `test_wrong_extension_id_is_not_ready`: a second stub at another path fails with `extension_not_loaded`.
  - `test_failed_sqlite_probe_is_not_ready`: a stub whose probe throws fails with `extension_not_loaded`.
  - `test_readiness_never_waits_past_the_deadline`: with `deadline = now + 1.0`, the call raises within 2 s.
  - `test_page_fetch_to_a_foreign_host_is_blocked`: a page `fetch("https://example.org/x")` shows up in `session.blocked`.
  - `test_website_service_worker_cannot_register`: `navigator.serviceWorker.register` on the fake listing rejects or registers nothing.
  - `test_extension_worker_fetch_to_a_foreign_host_fails`: with the real built extension's manifest CSP copied into the stub, `worker.evaluate("fetch('https://example.org/')")` rejects.
  - `test_cleanup_on_every_exit`: after a normal close, a raised exception inside the `with`, a launch failure (bad `CHROMIUM_EXECUTABLE`) and a readiness failure, no `chrome` or `Xvfb` process from the session is left, and its profile folder is gone.
  - `test_startup_sweeps_leftovers_from_a_killed_worker`: start a session in a child process, `SIGKILL` it, then `sweep_leftovers` returns at least 1, and no `chrome` or `Xvfb` from that child remains.
  - `test_two_sessions_get_their_own_display_and_profile`: two concurrent sessions have different `DISPLAY` values and profile paths.
  - `test_headless_flag_skips_xvfb`: with `headless=True` no `Xvfb` process starts.
- [ ] **Step 2: Run and confirm they fail.** Run: `docker run --rm --network none -v "$PWD:/app:ro" -w /app -e PYTHONPATH=/app/src auto24-extraction-service:chromium-test python -m pytest -q -p no:cacheprovider tests/test_browser_chromium.py`. Expected: all fail on import.
- [ ] **Step 3: Implement `browser_chromium.py`.**
  - Xvfb gets a free display chosen with `-displayfd`, `-nolisten tcp` and screen `1366x768x24`, in a new process group.
  - The profile is a `tempfile.mkdtemp(prefix="a24-chromium-", dir=<root>)`, with a pid file inside so `sweep_leftovers` can find it.
  - `patchright.sync_api.sync_playwright().chromium.launch_persistent_context(profile, executable_path=CHROMIUM_EXECUTABLE, headless=..., service_workers="block", args=[...])`. The args are `--load-extension` and `--disable-extensions-except` for `extension_dir`, plus the background-traffic flags from the spec.
  - Readiness first reads `context.service_workers`, then `context.wait_for_event("serviceworker", timeout=...)` bounded by `min(5 s, deadline - now)`. It matches `chrome-extension://<expected id>/background.js`, then runs `worker.evaluate("self.queryPhash({imgtype:'33', name:'buses', phash:'0'}).then(() => true)")`.
  - The route guard calls `guard.allowed_url(..., extension_id=id)`. Navigation reuses `browser._navigate`.
  - A `finally` closes the context, kills the Chromium and Xvfb process groups and removes the profile.
  - If `service_workers="block"` turns out to stop the extension's worker too, which `test_opens_the_fake_listing_with_the_extension_ready` shows, drop it. Block website workers with an init script that replaces `navigator.serviceWorker.register` with a rejecting function on `www.auto24.ee` pages only, and note the choice in the module docstring.
- [ ] **Step 4: Run the tests on arm64.** Expected: all pass.
- [ ] **Step 5: Run the launch, readiness and cleanup subset on amd64.** Run Step 2's command with `--platform linux/amd64` and image `auto24-extraction-service:chromium-amd64-test`, adding `-k "opens or cleanup or readiness"`. Expected: pass.
- [ ] **Step 6: Commit.** `git commit -m "feat: add the Chromium launcher with readiness checks and cleanup"`

### Task 5: Engine choice, diagnostics and the C1 capture path

**Files:**
- Modify: `src/auto24_service/contracts.py`, `src/auto24_service/worker.py`, `src/auto24_service/browser.py` (`capture_listing` records the engine)
- Test: `tests/test_contracts.py`, `tests/test_worker.py`

**Interfaces:**
- Produces:
  - `RevealDiagnostics.engine: Literal["camoufox", "chromium"] = "camoufox"`
  - `RevealDiagnostics.extension_loaded: bool | None = None`
  - `AttemptRecord.solver` and `RoundRecord.solver`, both `Literal["python", "extension"] = "python"`
  - `parse_capture_engine(value: str | None) -> Literal["camoufox", "chromium"]`, which raises `ValueError` on anything else
  - In C1, the Chromium path calls `capture_listing(..., opener=CHROMIUM_OPENER, reveal=skip_reveal)`. `skip_reveal(session, reopen, solver, **kw) -> RevealOutcome` keeps listed-in-full and not-listed fields, sets hidden ones to `unavailable` with zero attempts, and sets `engine="chromium"` and `extension_loaded`. Task 7 replaces `skip_reveal`.
- [ ] **Step 1: Write the failing tests:**
  - `test_old_records_read_as_python_and_camoufox`: old JSON without the new fields parses with `solver == "python"` and `engine == "camoufox"`.
  - `test_parse_capture_engine`: `None` and `"camoufox"` give `"camoufox"`, `"chromium"` gives `"chromium"`, and `"firefox"` raises.
  - `test_worker_refuses_unknown_engine`: `main()` with `CAPTURE_ENGINE=x` exits through `argument_parser.error`.
  - `test_chromium_engine_wires_the_chromium_opener`: with `CAPTURE_ENGINE=chromium`, the capture partial uses `CHROMIUM_OPENER`.
  - `test_skip_reveal_marks_hidden_fields_unavailable_and_records_the_engine`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** The Chromium worker loads no Python solver. It passes `solver=None` and skips `CAPTCHA_SOLVER_DIR` verification.
- [ ] **Step 4: Run `tests/test_contracts.py`, `tests/test_worker.py` and `tests/test_browser.py`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: choose the capture engine and record it in the diagnostics"`

### Task 6: Network sandbox on the Chromium image

**Files:**
- Modify: `compose.sandbox.yaml` (a `capture-chromium` service using `auto24-extraction-service:chromium`), `scripts/network-sandbox` (`--engine camoufox|chromium`), `scripts/sandbox-live-capture.py` (`--engine`)
- Test: `tests/test_compose_contract.py`, `tests/test_live_capture_script.py`

- [ ] **Step 1: Write the failing tests:**
  - `test_sandbox_chromium_capture_has_no_reports_mount`
  - `test_live_capture_script_accepts_engine_chromium`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** The offline mode launches the Chromium session against the fake site with the real extension, and keeps the browser open for 30 s, so update and field-trial requests have time to fire.
- [ ] **Step 4: Run `scripts/network-sandbox offline --engine chromium`.** Expected: `PASS` and `contacted hosts: none`. If it fails, add the Chromium flag that stops each listed host, rerun, and record each added flag in `browser_chromium.py` next to the host it stops.
- [ ] **Step 5: Commit.** `git commit -m "test: run the network sandbox on the Chromium engine"`

Deliver C1 under [checking a checkpoint](../../../AGENTS.md#checking-a-checkpoint), using the spec's C1 "How to check" steps 1 to 4.

---

## Checkpoint C2: Plan A reveal and the engine benchmark

### Task 7: Watch the extension solve

**Files:**
- Create: `src/auto24_service/captcha/extension_wait.py`
- Modify: `src/auto24_service/captcha/reveal.py` (`_Attempt.solve` dispatches on the solver), `src/auto24_service/worker.py` (replace `skip_reveal` with `reveal_registration` and `solver=EXTENSION`)
- Modify: `tests/fakesite/__init__.py` (Scenario fields `challenge_ids`, `repeat_replies`, `silent_after_s`)
- Test: `tests/test_extension_wait.py` (Chromium image)

**Interfaces:**
- Produces: `EXTENSION: Final` sentinel solver, and `watch_extension(page, *, deadline: float, rounds_left: int, clock=time.monotonic, stall_s: float = 20.0, debug=None) -> CaptchaResult`. The `CaptchaResult` is the type from `recaptcha.py`. Its rounds carry `solver="extension"` and empty `tiles`, and `incomplete=True` for an unknown reply format. Add `incomplete: bool = False` to `RoundRecord`.
- Rounds are keyed by the challenge id (the `rresp` or `c` id field Plan B's driver already parses), and a repeated id is the same round. A dynamic grid's tile refills stay in their round. A round ends at its `userverify` reply.
- Progress is a new round, new tile `src` values in the open bframe, `aria-checked="true"` on the anchor, or the field's value appearing. Anything else does not reset the stall timer.
- [ ] **Step 1: Write the failing tests** with the stub extension and the fake site:
  - `test_reveals_both_values_and_records_extension_rounds`: both values `revealed`, and rounds have `solver == "extension"`.
  - `test_repeated_replies_for_one_challenge_count_once`: `Scenario(repeat_replies=3)` gives 1 round.
  - `test_dynamic_refills_stay_in_one_round`
  - `test_three_failed_rounds_give_rounds_exhausted`
  - `test_no_progress_for_20_s_is_a_stall_timeout`: `Scenario(silent_after_s=0)` gives reason `timeout` and stage `stall` within 25 s, and attempt 2 still runs within the lease.
  - `test_chatter_does_not_reset_the_stall_timer`: periodic unrelated XHRs on the page don't extend the stall.
  - `test_unknown_reply_format_marks_incomplete_but_keeps_the_value`
  - `test_try_again_later_is_reported`
  - `test_worker_restart_during_attempt_does_not_hang`: stop the stub's worker with CDP `ServiceWorker.stopWorker` mid-attempt. The attempt ends within its cap with either `revealed` or a named reason.
  - `test_listed_in_full_needs_no_wait`: both values listed in full means no wait, and the reveal ends in under 2 s.
  - `test_value_checks_unchanged`: a page value different from the JSON gives `value_rejected`, and a prefix mismatch gives `prefix_mismatch`.
  - `test_chromium_crash_mid_reveal_completes_the_capture`: kill the Chromium process group after the trigger click. Both hidden fields come back `unavailable`, and `capture_listing` returns the HTML.
  - `test_debug_screenshots_mask_values_on_chromium`: with a `DebugRecorder`, the `attempt_end` screenshot's reg value cell is solid black, as in the Camoufox test.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** Add `stall` to `AttemptStage`. `_Attempt.solve` calls `watch_extension` when `self.solver is EXTENSION`, and `solve_recaptcha` otherwise. Everything after the call is unchanged, `value_after_widget_gone` included.
- [ ] **Step 4: Run `tests/test_extension_wait.py`, `tests/test_reveal.py` and `tests/test_captcha_driver.py`.** Expected: all pass. Plan B is unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat: reveal on Chromium by watching the extension solve"`

### Task 8: Real-extension smoke test

**Files:**
- Test: `tests/test_real_extension_smoke.py` (Chromium image, both platforms)
- Modify only if the real extension needs it: `tests/fakesite/pages/anchor.html`, `bframe.html`, with each change recorded in the test's docstring.

- [ ] **Step 1: Write the tests** with `extension_dir=/opt/captcharaptor-extension` and the fake site:
  - `test_real_extension_submits_a_3x3_answer`: after the trigger click, the fake site's log shows a checkbox click, at least one tile click and one `userverify` within 30 s.
  - `test_real_extension_submits_a_4x4_answer`: the same, with the 4x4 scenario.
  - `test_real_extension_loads_models_wasm_and_sqlite`: the guard log contains `chrome-extension://<id>/models/type.onnx`, `models/grid.onnx`, `libs/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm` and `db/captcha.sqlite`, and `session.blocked` is empty.
- [ ] **Step 2: Run on arm64.** If a test fails because the fake frames lack something the extension reads, change the fake page to match Google's real markup, and only that.
- [ ] **Step 3: Run on amd64** with `--platform linux/amd64`. Expected: all 3 pass.
- [ ] **Step 4: Commit.** `git commit -m "test: smoke-test the real extension on amd64 and arm64"`

### Task 9: Benchmark engines and shared mode

**Files:**
- Modify: `src/auto24_service/captcha_benchmark.py`
- Test: `tests/test_captcha_benchmark.py`

**Interfaces:**
- `--engine camoufox|chromium|both` (default `camoufox`), and `--mode` taking one or more of `fresh saved shared`.
- Report key `results["<engine>/<mode>"]` replaces `results["<mode>"]`. The gate is computed for `chromium/fresh` and `camoufox/fresh`. Each result has `capture_errors_counted: true`.
- [ ] **Step 1: Write the failing tests:**
  - `test_capture_errors_count_as_failed_reveals`: 8 passes plus 2 capture errors gives `attempted == 10`, a 0.8 rate, and gate PASS. 7 passes plus 3 errors fails.
  - `test_engine_both_runs_each_engine_on_the_same_listings`
  - `test_shared_mode_reuses_one_session_and_counts_no_captcha_needed`
  - `test_shared_results_never_decide_the_gate`
  - `test_summary_prints_one_line_per_engine_and_mode`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** Shared mode opens one `open_chromium_listing` session and runs each listing in `session.context.new_page()`, with the guard installed per page. It closes the session and profile at the end of the run.
- [ ] **Step 4: Run `tests/test_captcha_benchmark.py`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: benchmark both engines and a shared Chromium session"`

### Task 10: Docs and the C2 handoff

**Files:**
- Modify: `docs/chromium-engine.md` (fetch, build, run the Chromium engine and the update rule from the spec: bump Chromium and Patchright together at least monthly and after Chromium security releases, rerunning the pins, both smoke tests and the offline sandbox), `docs/local-development.md` (benchmark commands), `docs/superpowers/service-roadmap.md` (add S2 with C1 and C2 and their status)
- Create: `docs/superpowers/checkpoints/2026-10-19-chromium-engine.md`, holding the evidence (test counts per platform, sandbox report names) and the user's C2 "How to check" steps verbatim from the spec

- [ ] **Step 1: Write the docs.** Run the full offline suite on arm64 and the Chromium subset on amd64, and record the counts.
- [ ] **Step 2: Commit.** `git commit -m "docs: document the Chromium engine and hand over C2 checks"`

Deliver C2 under [checking a checkpoint](../../../AGENTS.md#checking-a-checkpoint), using the spec's C2 steps on the `x86_64` server. Replacing Plan B needs 3 passing `chromium/fresh` runs in a row.
