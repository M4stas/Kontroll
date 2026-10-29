# invisible_playwright MNT lookup engine implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lookup-only worker runs the Transpordiamet background check (taustakontroll) on invisible_playwright's patched Firefox, and the Chromium worker can hand all lookups to it.

**Architecture:** The MNT driver in `mnt_lookup.py` stays engine-neutral. Two engine differences move into the session: how the driver sees that reCAPTCHA has loaded, and how it receives the PDF. A new `browser_invisible.py` opens a guarded invisible_playwright session for the `MNT` allowlist. A new `lookup_worker.py` claims only lookups, and it runs in its own image and compose service, `worker-invisible`.

**Tech Stack:** Python 3.12, invisible_playwright 0.43.0 with invisible_core 53.48.0 (patched Firefox `firefox-53`, built as Firefox 151.0), Docker linux/arm64 on the Mac and linux/amd64 on the server, pytest.

**Spec:** [background check spec](../specs/2026-10-22-transpordiamet-background-check-design.md). This plan adds a second lookup engine to S4 A and keeps its contract, states, limits and PDF check.

## Why this engine

On 2026-10-29 the app's own `lookup_background_check` ran against live MNT from a Mac in Docker, 8 lookups per engine, taking turns on the user's 4 test plates, with `recaptcha_s=7`, `answer_s=20` and 12 s between lookups. Neither engine had the CaptchaRaptor extension.

| Engine | PDF fetched | Median time when fetched | Failures |
| --- | --- | --- | --- |
| invisible_playwright | 8 of 8 | 18 s | none |
| Camoufox | 1 of 8 | 12 s | 7 × `captcha_failed`, MNT rejected the v3 token on both attempts |

The same session audited invisible_playwright and invisible_core by reading their code. There is no `eval`, `exec`, `shell=True` or pickle, and no telemetry. The engine archive must match a sha256 from the seal shipped in invisible_core. Each launch looks up its public IP from `api.ipify.org`, `icanhazip.com` or `checkip.amazonaws.com` unless the locale and timezone are given. The GeoIP database it downloads is not hash-checked. Archive extraction uses `extractall` with no path filter, which is safe only because the archive's sha256 is checked first.

## Global constraints

- Pin `invisible_playwright==0.43.0` and `invisible_core==53.48.0`. Install them with `pip install --require-hashes` from `vendor/invisible/requirements.txt`, which lists every wheel for linux/arm64 and linux/amd64.
- The engine archive comes from `invisible-playwright fetch` at image build time only. The worker never downloads at run time.
- Every session passes `locale="et-EE"` and `timezone="Europe/Tallinn"` so that launch makes no egress-IP lookup.
- invisible_playwright runs only in its own image, as a non-root user. No invisible_playwright code runs on the host.
- Lookups keep the S4 A limits from `mnt_lookup.Limits`, the 240 s lease and the one retry in a fresh session.
- Identity values never appear in logs, commits, docs or test files. Tests use the fake MNT site's made-up values.
- The Chromium worker's default behavior does not change. `CHROMIUM_LOOKUPS` defaults to `true`.

## Review focus

1. A page opens a WebSocket to a host outside the allowlist. Firefox has no route hook for WebSockets, so the session must turn them off with a pref. Task 3 tests this.
2. "Salvestan" returns the PDF inline with no `attachment` header, or returns an HTML error page. The response capture must accept only a `%PDF-` body and leave the size and value checks to `pdf_matches`. Task 3 tests this.
3. Firefox outlives the session after a crash or the deadline. The next lookup must not find a stray Firefox or a locked profile. Task 3 tests that the session kills its browser tree 5 s after the deadline.
4. invisible_core still calls an IP echo service when locale and timezone are set. The offline launch test in Task 3 runs with `--network none` and must launch.
5. Both workers claim the same lookup. Storage leases already prevent a double claim. Task 4 tests that `CHROMIUM_LOOKUPS=false` keeps the Chromium worker from claiming lookups at all.

---

## Checkpoint S5: Background check on invisible_playwright

### Before starting

- The user approves this plan.
- Confirm by reading `invisible_core/_geo.py` and `launch.py` at 53.48.0 that an explicit locale and timezone skip `discover_egress_ip`. If a launch still needs an IP lookup, stop and ask the user before allowing an IP echo host.
- Run the same 8-lookup comparison with the Chromium `worker` image and `lookup_background_check` as it is today. If Chromium fetches 7 or more of 8, ask the user whether S5 should still go ahead, since it would only back up Chromium.

### What you will see

With `worker-invisible` running and `CHROMIUM_LOOKUPS=false` on the Chromium worker, pressing the report button gives "PDF ready" on the "Transpordiamet background check" line, as in checkpoint 11. The `worker-invisible` log shows `background_check=fetched engine=invisible` for that job, and the Chromium worker log shows no lookup.

### How to check

1. Build the images: `docker compose --profile invisible build worker worker-invisible`.
2. Run `scripts/network-sandbox offline --engine invisible`. It prints "offline background check: fake MNT search fetched a fake PDF" and PASS with no contacted hosts.
3. Set `CHROMIUM_LOOKUPS=false` in `.env`, then start the stack with `docker compose --profile invisible up -d` and the app as described in [local development](../../local-development.md).
4. Submit an Auto24 link you supply and press the report button when the reg number shows.
5. The background check line pulses, then shows "PDF ready". Open the PDF. It shows the listing's reg number and VIN.
6. Run `docker compose logs worker-invisible | grep background_check`. It shows `fetched` and `engine=invisible`. `docker compose logs worker | grep background_check` shows nothing for this job.
7. Stop `worker-invisible` and press the report button on another listing. After 4 minutes the line reads "Unavailable", and the rest of the report finishes.
8. Remove `CHROMIUM_LOOKUPS` from `.env` and restart. The Chromium worker claims lookups again, as before this checkpoint.

### Task 1: Engine-neutral MNT driver

**Files:**
- Create: `src/auto24_service/session.py`
- Modify: `src/auto24_service/browser.py` (move `CaptureError` and `ListingSession` out, import them back)
- Modify: `src/auto24_service/mnt_lookup.py:262-276` (`wait_for_recaptcha`), `:390-413` (`download`), `:163-181` (`run`, `drive`)
- Test: `tests/test_mnt_lookup_unit.py`

**Interfaces:**
- Produces: `auto24_service.session.CaptureError` and `auto24_service.session.ListingSession`, with the fields they have today plus `engine: Literal["camoufox", "chromium", "invisible"] = "chromium"`. `browser.py` and `browser_chromium.py` keep importing both names, so existing imports still work.
- Produces: `mnt_lookup` imports nothing that needs Camoufox, Patchright or BeautifulSoup.
- Produces: the driver calls `session.engine` to choose a reCAPTCHA check and a PDF capture. For `"invisible"` it calls `browser_invisible.recaptcha_badge_shown(page) -> bool` and `browser_invisible.expect_pdf_response(page, timeout_ms: int)` from Task 3, imported inside the branch.

- [ ] **Step 1: Write the failing tests**

```python
def test_mnt_lookup_imports_without_camoufox_or_patchright():
    # Run in a subprocess with camoufox, patchright and bs4 blocked by a meta path finder.
    assert run_import_blocked("auto24_service.mnt_lookup", blocked=("camoufox", "patchright", "bs4")) == 0

def test_invisible_session_waits_for_the_badge(monkeypatch):
    calls = fake_invisible_session(badge_after_polls=2)
    attempt(session=calls.session).wait_for_recaptcha(calls.session)
    assert calls.badge_checks == 3 and calls.isolated_context_evaluates == 0

def test_invisible_session_takes_the_pdf_from_the_response(monkeypatch):
    calls = fake_invisible_session(pdf_body=b"%PDF-1.4 fake")
    assert attempt(session=calls.session).download(calls.session) == b"%PDF-1.4 fake"
    assert calls.expect_download_calls == 0
```

`run_import_blocked`, `fake_invisible_session` and `attempt` are test helpers in the same file. The fake session monkeypatches `browser_invisible.recaptcha_badge_shown` and `browser_invisible.expect_pdf_response`.

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pytest-service tests/test_mnt_lookup_unit.py -q`
Expected: 3 failures. The import test fails on `bs4`, and the other two fail because `wait_for_recaptcha` and `download` take a page.

- [ ] **Step 3: Implement**

Move the two classes to `session.py` with no change of behavior. `wait_for_recaptcha(self, session)` and `download(self, session)` take the session. For `"invisible"`, the first polls `recaptcha_badge_shown(page)` and the second uses `expect_pdf_response`. Every other engine keeps today's code, including `isolated_context=False`. `run()` imports `CaptureError` from `session`.

- [ ] **Step 4: Run the unit tests and the Chromium driver tests**

Run: `scripts/pytest-service tests/test_mnt_lookup_unit.py tests/test_browser.py -q`, then the Chromium subset in the `chromium-test` image: `tests/test_mnt_lookup.py`.
Expected: all pass. The 19 Chromium MNT driver tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/auto24_service/session.py src/auto24_service/browser.py src/auto24_service/mnt_lookup.py tests/test_mnt_lookup_unit.py
git commit -m "refactor: let the MNT driver run on more than one engine"
```

### Task 2: invisible image and pinned inputs

**Files:**
- Create: `Dockerfile.invisible`, `vendor/invisible/requirements.txt`, `vendor/invisible/README.md`
- Modify: `compose.yaml` (service `worker-invisible`, profile `invisible`, image `auto24-extraction-service:invisible`), `scripts/pytest-service` (`--image invisible`)
- Test: `tests/test_compose_contract.py`, new `tests/test_invisible_image.py`

**Interfaces:**
- Produces: image `auto24-extraction-service:invisible` from `python:3.12-slim-bookworm` with Xvfb, the Firefox runtime libraries from `Dockerfile`, the app's own dependencies except `camoufox` and `onnxruntime`, the pinned invisible packages, the fetched engine in the `worker` user's cache, and `src` installed with `--no-deps`. User `worker`, uid 10001. Entrypoint `python -m auto24_service.lookup_worker`.
- Produces: `worker-invisible` takes `INTERNAL_API_KEY`, `STORAGE_URL=http://storage:8001`, `BACKGROUND_CHECK_DIR` and the `background_checks` volume, as `worker` does today.
- Produces: `scripts/pytest-service --image invisible [--network none] <args>` runs pytest in that image, with no network when asked.

- [ ] **Step 1: Write the failing tests**

`tests/test_compose_contract.py`: `worker-invisible` exists only in profile `invisible`, uses the image above, mounts `background_checks` at the same path as `worker`, and sets no `CAPTURE_ENGINE`. `tests/test_invisible_image.py`: every line in `vendor/invisible/requirements.txt` has a `--hash=sha256:` entry, both packages are pinned with `==` to the versions above, and `Dockerfile.invisible` runs `pip install --require-hashes`, runs `invisible-playwright fetch` in a `RUN` step, and ends with a non-root `USER`.

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pytest-service tests/test_compose_contract.py tests/test_invisible_image.py -q`
Expected: failures for the missing service and files.

- [ ] **Step 3: Write the files**

Generate the hash file with `pip download --only-binary=:all:` for both platforms in a disposable container, then `pip hash`. `vendor/invisible/README.md` says how to regenerate it and records the audit date, the two versions and the engine tag `firefox-53`.

- [ ] **Step 4: Build and run the tests**

Run: `docker compose --profile invisible build worker-invisible`, then the Step 2 command.
Expected: the build ends with `invisible-playwright fetch` reporting the sha256 verified, and the tests pass.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.invisible vendor/invisible compose.yaml scripts/pytest-service tests/test_compose_contract.py tests/test_invisible_image.py
git commit -m "build: add a pinned invisible_playwright worker image"
```

### Task 3: Guarded invisible session

**Files:**
- Create: `src/auto24_service/browser_invisible.py`
- Test: `tests/test_browser_invisible.py` (skips unless `invisible_playwright` imports, like `test_mnt_lookup.py` does for Chromium)

**Interfaces:**
- Consumes: `guard.allowed_url`, `guard.blocked_entry`, `guard.MNT`, `session.ListingSession`, `session.CaptureError`, and `tests.fakesite.mnt.install_fake_mnt`.
- Produces: `open_invisible_session(*, site: SiteAllowlist, setup=None, deadline: float | None = None, keep_profile: Path | None = None) -> AbstractContextManager[ListingSession]`, which yields a session with `engine="invisible"`. Its signature fits the `opener` argument of `lookup_background_check`.
- Produces: `recaptcha_badge_shown(page) -> bool` and `expect_pdf_response(page, timeout_ms: int) -> AbstractContextManager[PdfResponse]`, where `PdfResponse.body: bytes | None` is set on exit.

- [ ] **Step 1: Write the failing tests**

```python
def test_session_launches_with_no_network():       # run with --network none; launch succeeds
def test_requests_outside_the_mnt_allowlist_are_blocked_and_recorded():
    # same URLs as test_mnt_session_guards_requests_with_the_mnt_allowlist; session.blocked lists them
def test_websockets_are_refused():
    # the fake page opens wss://eteenindus.mnt.ee/x; the page sees an error event, no socket opens
def test_pdf_response_is_taken_without_a_download_event():
    # the fake "Salvestan" answers application/pdf with Content-Disposition: attachment
def test_inline_pdf_without_attachment_is_taken():
def test_html_answer_to_salvestan_gives_no_body():
def test_browser_is_killed_five_seconds_after_the_deadline():
    # no firefox process of this session is left 6 s after the deadline
def test_fetches_the_pdf_by_reg_number_on_the_fake_site():
    # lookup_background_check(..., opener=partial(open_invisible_session, site=MNT, setup=install_fake_mnt))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pytest-service --image invisible --network none tests/test_browser_invisible.py -q`
Expected: an `ImportError` for `browser_invisible`.

- [ ] **Step 3: Implement `open_invisible_session`**

Launch `InvisiblePlaywright(headless=True, locale="et-EE", timezone="Europe/Tallinn", show_cursor=False, extra_prefs={"network.websocket.max-connections": 0})`. Use `profile_dir=keep_profile` when given. Open one context with `accept_downloads=False`, install a `context.route("**/*")` guard that calls `allowed_url(url, main_frame=request.is_navigation_request() and request.frame.parent_frame is None, site=site)`, record blocked entries, and set `main_frame_blocked` the way `browser._install_guards` does. A watchdog thread kills the session's Firefox tree with `psutil` 5 s after `deadline`. Map launch failures to `CaptureError("browser_launch")`. `expect_pdf_response` keeps the first response whose body starts with `%PDF-`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command.
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/auto24_service/browser_invisible.py tests/test_browser_invisible.py
git commit -m "feat: open guarded invisible_playwright sessions for MNT"
```

### Task 4: Lookup-only worker and the Chromium switch

**Files:**
- Create: `src/auto24_service/lookup_worker.py`
- Modify: `src/auto24_service/worker.py:240-245` (log the engine), `:390-415` (`CHROMIUM_LOOKUPS`)
- Test: `tests/test_worker.py`, new `tests/test_lookup_worker.py`

**Interfaces:**
- Consumes: `worker.run_background_check(client, lookup, directory) -> bool`, `open_invisible_session` from Task 3.
- Produces: `lookup_worker.main(argv) -> int` with `--once`. It loops on `run_background_check` and sleeps 1 s when nothing was claimed. It never calls `client.claim()`.
- Produces: `run_background_check` gains `engine: str` and logs `engine=<engine>` next to `background_check=`.
- Produces: `CHROMIUM_LOOKUPS=true|false`, default `true`. Any other value is a startup error, as with `CHROMIUM_WARM_PROFILE`.

- [ ] **Step 1: Write the failing tests**

```python
def test_lookup_worker_claims_lookups_and_never_jobs():
def test_lookup_worker_logs_engine_invisible():
def test_lookup_worker_survives_a_failing_claim():          # claim raises, the loop goes on
def test_chromium_lookups_false_never_claims_a_lookup():
def test_chromium_lookups_rejects_other_values():
def test_chromium_lookups_defaults_to_true():
```

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pytest-service tests/test_worker.py tests/test_lookup_worker.py -q`
Expected: failures for the missing module and setting.

- [ ] **Step 3: Implement**

`lookup_worker` reads `STORAGE_URL`, `INTERNAL_API_KEY` and `BACKGROUND_CHECK_DIR` like `worker.main`. Its lookup is `functools.partial(lookup_background_check, opener=functools.partial(open_invisible_session, site=MNT))`. In `worker.main`, `CHROMIUM_LOOKUPS=false` leaves `lookup_options` empty.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the whole default suite once: `scripts/pytest-service -q`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/auto24_service/lookup_worker.py src/auto24_service/worker.py tests/test_worker.py tests/test_lookup_worker.py
git commit -m "feat: run MNT lookups on a lookup-only invisible worker"
```

### Task 5: Network sandbox, docs and the live check

**Files:**
- Modify: `scripts/network-sandbox` (`--engine invisible`, offline mode only), `compose.sandbox.yaml` (service `capture-invisible`), `scripts/sandbox-live-capture.py` (offline fake MNT lookup on the invisible opener)
- Modify: `docs/local-development.md` (`worker-invisible` and `CHROMIUM_LOOKUPS`), `docs/superpowers/service-roadmap.md` (S5 status)
- Create: `docs/superpowers/checkpoints/2026-10-29-s5-invisible-lookup.md`
- Test: `tests/test_live_capture_script.py`, `tests/test_sandbox_report.py`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces: `scripts/network-sandbox offline --engine invisible` runs one fake MNT lookup in `capture-invisible` and writes the usual report. `live --engine invisible` exits with usage, because live captures are Auto24 listings and this engine runs no captures.

- [ ] **Step 1: Write the failing tests**

`test_live_capture_script.py`: `--engine invisible --offline` runs only the fake MNT lookup and prints the line from "How to check" step 2. `test_sandbox_report.py`: the usage text lists `invisible`, and `live --engine invisible` exits with code 2.

- [ ] **Step 2: Run them to verify they fail**

Run: `scripts/pytest-service tests/test_live_capture_script.py tests/test_sandbox_report.py -q`
Expected: failures for the unknown engine.

- [ ] **Step 3: Implement and document**

The checkpoint doc follows `2026-10-22-s4-a-background-check.md`: what each task added, an offline evidence table, and a live section that records outcomes only.

- [ ] **Step 4: Verify**

Run: the Step 2 command, then `scripts/network-sandbox offline --engine invisible`.
Expected: tests pass, and the sandbox reports PASS with no contacted hosts.

- [ ] **Step 5: Live check, with the user's approval first**

Ask the user before any live lookup. With approval, run 8 lookups through `worker-invisible` on the user's test plates with `CHROMIUM_LOOKUPS=false`, and record the fetched count and median time in the checkpoint doc. Then stop and hand over "How to check".

- [ ] **Step 6: Commit**

```bash
git add scripts/network-sandbox compose.sandbox.yaml scripts/sandbox-live-capture.py docs tests/test_live_capture_script.py tests/test_sandbox_report.py
git commit -m "docs: record the invisible_playwright lookup checkpoint"
```

## Not in this plan

- Falling back from Chromium to invisible_playwright when a Chromium lookup ends as `captcha_failed` or `blocked`. Plan it only if the live check shows Chromium failing where invisible succeeds.
- Listing captures on invisible_playwright. The reveal depends on the CaptchaRaptor extension, which is Chromium only.
- A warm profile for `worker-invisible`. Fresh sessions fetched 8 of 8.
