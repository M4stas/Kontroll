# Chromium Identity Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run production captures on Chromium, complete each job as soon as the listing is parsed, fill in the registration number and VIN when the reveal finishes, and show them on the listing page.

**Architecture:** The worker completes the job right after parsing, with both identity fields `pending` and a one-time reveal token. The same browser session then runs the extension reveal and posts the result to a new storage endpoint, which accepts it only with that token and before a fixed deadline. A pending reveal that misses the deadline reads back as `unavailable`. The website keeps polling a completed job while either field is `pending`, and maps the statuses to the listing card's existing identity rows.

**Tech Stack:** Python 3.12, FastAPI, pyturso (`store.py`), Patchright + ungoogled-chromium (`Dockerfile.chromium`), Next.js + zod + vitest, pnpm.

**Spec:** No new spec. This plan argues from `docs/superpowers/specs/2026-10-11-auto24-registration-reveal-design.md` (S1, contracts and statuses) and `docs/superpowers/specs/2026-10-19-chromium-extension-engine-design.md` (S2, engine). New decisions are recorded in Checkpoint A, "Before starting".

## Global Constraints

- No real plates or VINs in code, tests, docs, commits or chat. Fake values only (`123ABC`, `WVWZZZ1KZAW000001`).
- Revealed values never go into logs, error messages, analytics or reports other than the job's listing.
- No new outbound hosts. The page guard and WebSocket guard stay as they are.
- `FieldStatus` gains `pending`. All other contract changes are additive with defaults; records without `registration` still parse.
- Reveal budget after completion: `REVEAL_SECONDS = 120`. A `pending` field older than that reads as `unavailable`.
- Website polling: `POLL_INTERVAL_MS = 1_000` unchanged; polling continues after `completed` only while a field is `pending`, for at most `REVEAL_SECONDS`.
- Agents run offline tests only. Live captures and benchmarks need the user's approval each time.
- Python tests without a browser run in `auto24-extraction-service:sandbox` with `--network none`; Chromium tests in `auto24-extraction-service:chromium-test`; website tests with `pnpm test`, types with `pnpm typecheck`, lint with `pnpm lint`. The repo uses pnpm; never npm.
- `main` records capture timing spans under the job's lease (`SpanRecorder`, `diagnostic_omitted`). Spans after completion would be rejected, so timing stops at completion.
- No AI attribution lines in commits. No em dashes in docs or commits. Ask before pushing.

## Shared contract (frozen before A and B start)

A and B run in parallel against this contract. Neither side changes it without updating this section first.

The job JSON from `GET /v1/jobs/{job_id}` (and the website's `/api/listings/[jobId]` proxy) carries the identity inside `listing`:

```json
{
  "status": "completed",
  "parsed_at": "2026-10-21T12:00:05Z",
  "listing": {
    "registration": {
      "reg_number": null, "reg_number_status": "pending",
      "vin": null, "vin_status": "pending", "vin_format": null
    }
  }
}
```

- Statuses: `listed_in_full`, `revealed`, `not_listed`, `unavailable`, `pending`. A value is non-null exactly for `listed_in_full` and `revealed`. `vin_format` is `standard`, `nonstandard` or `null`.
- `pending` appears only on `completed` jobs, for at most `REVEAL_SECONDS = 120` after `parsed_at`. After that the service reports `unavailable`. The website treats `pending` older than `parsed_at + 120 s` as `unavailable` too.
- `registration` may be absent or `null` (older jobs, Camoufox jobs without a reveal). The card then hides the identity rows.
- Example values in tests: `123ABC`, `WVWZZZ1KZAW000001`.

## Parallel work

A and B touch disjoint files and can be built at the same time. B's code is safe without A: until A ships, `registration` never contains `pending`, and B renders whatever final statuses arrive.

| | Checkpoint A (Claude) | Checkpoint B (Codex) |
|---|---|---|
| Branch | `claude/s3-a-identity-service`, from `main` | `codex/s3-b-identity-listing-page`, from `main` |
| Owns | `src/auto24_service/`, `compose*.yaml`, `Dockerfile*`, `.dockerignore`, Python `tests/test_*.py`, `docs/local-development.md`, `docs/superpowers/service-roadmap.md`, the checkpoint doc | `src/listings/`, `src/features/listing/`, `tests/*listing*.test.ts`, `tests/captured-listing.test.ts`, `tests/unit/listing/`, the S3 B row in `docs/superpowers/roadmap.md` |
| Never touches | anything B owns | anything A owns |
| Builds against | this contract | this contract, with fake jobs in tests |
| How to check needs | A only | A merged (or running locally), because live pending identities come from A |

Merge order: either PR can merge first. Checkpoint C starts after A merges. If one side needs a contract change, it stops and asks the user, and the user tells the other side.

## Review Focus

1. Worker dies mid-reveal: the job stays `completed` and both fields read `unavailable` once `REVEAL_SECONDS` pass. Test in Task 1 (`test_pending_registration_expires_to_unavailable`).
2. A reveal posts after its deadline or with a wrong token: storage rejects it and the job is unchanged. Test in Task 1 (`test_late_or_wrong_token_registration_is_rejected`).
3. Both values listed in full: the job still completes before the reveal, and the fields switch to `listed_in_full` within a second. Test in Task 3 (`test_listed_in_full_fills_in_right_after_completion`).
4. The tab is hidden or the poll deadline passes while a field is `pending`: the card shows "not found" for pending fields, never an endless pulse. Test in Task 6 (`test_pending_identity_stops_at_the_reveal_deadline`).
5. Old jobs stored before this change (no `registration`, no reveal columns): they still load and the card hides the identity rows. Tests in Task 1 (`test_old_rows_without_reveal_columns_load`) and Task 6 (`test_job_without_registration_has_no_identity`).

---

## Checkpoint A: Chromium in production, identity filled in after completion

### What you will see

A job submitted in the extraction API docs page turns `completed` within a few seconds with both identity fields `pending`. Polling it again a few seconds later shows `revealed` (or `listed_in_full`, `not_listed`, `unavailable`), with `engine: chromium` in the reveal diagnostics. The default `worker` service runs Chromium.

### How to check

1. Rebuild and start the stack: `docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 up -d --build storage api worker`.
2. Open http://localhost:8000/docs, authorize with your API key, and `POST /v1/jobs` with a listing that has a hidden reg number.
3. Poll `GET /v1/jobs/{job_id}` every couple of seconds. Expect `status: completed` and `reg_number_status: pending` first, then a final status within about 30 s.
4. Confirm `reveal_diagnostics.engine` is `chromium` and the `worker` container's image is `auto24-extraction-service:chromium`.
5. Stop the worker while a reveal runs (`docker compose -p auto24 stop worker` right after the job completes). After 2 minutes, the job shows both fields `unavailable`.

### Before starting

- [ ] Record these decisions at the top of `docs/superpowers/checkpoints/2026-10-19-chromium-engine.md` under a new "Identity integration decisions" heading:
  - The job completes after parsing; identity follows through `POST /internal/jobs/{job_id}/registration`.
  - `pending` is a `FieldStatus`. `REVEAL_SECONDS = 120`. A pending field past its deadline reads `unavailable`.
  - The reveal token is a new random value per job, separate from the lease token, and is cleared when used.
  - The default `worker` runs Chromium; Camoufox stays available as `worker-camoufox` under the `camoufox` profile.
  - A warm persistent worker profile is Checkpoint C, after A and B.

### Task 1: Pending status and the reveal record in the store

**Files:**
- Modify: `src/auto24_service/contracts.py` (`FieldStatus`, `Registration`)
- Modify: `src/auto24_service/store.py` (schema, `complete`, new `set_registration`, `_record`)
- Test: `tests/test_store.py`, `tests/test_contracts.py`

**Interfaces:**
- Produces: `FieldStatus = Literal["listed_in_full", "revealed", "not_listed", "unavailable", "pending"]`
- Produces: `Registration.pending() -> Registration` (classmethod; both statuses `pending`, values `None`)
- Produces: `JobStore.complete(job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, diagnostic_omitted: int = 0, reveal_token: str | None = None) -> bool`. With a token, stores `reveal_token` and `reveal_until = parsed_at + REVEAL_SECONDS`. The existing `result_persistence` span and `diagnostic_omitted` handling stay as they are.
- Produces: `JobStore.set_registration(job_id: str, reveal_token: str, registration: dict[str, Any], reveal_diagnostics: dict[str, Any] | None) -> bool`
- Produces: `REVEAL_SECONDS = 120` in `store.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_pending_registration_is_valid():
    r = Registration.pending()
    assert (r.reg_number, r.reg_number_status, r.vin, r.vin_status) == (None, "pending", None, "pending")

def test_set_registration_replaces_pending(store_and_claim):
    store, claim = store_and_claim
    assert store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    final = {"reg_number": "123ABC", "reg_number_status": "revealed", "vin": None, "vin_status": "not_listed", "vin_format": None}
    assert store.set_registration(claim.job_id, "rt-1", final, {"engine": "chromium", "attempts": []})
    job = store.get(claim.job_id)
    assert job.listing["registration"] == final
    assert job.reveal_diagnostics["engine"] == "chromium"
    assert not store.set_registration(claim.job_id, "rt-1", final, None)  # token is single use

def test_late_or_wrong_token_registration_is_rejected(store_and_claim, clock):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    assert not store.set_registration(claim.job_id, "other", FINAL, None)
    clock.advance(seconds=121)
    assert not store.set_registration(claim.job_id, "rt-1", FINAL, None)
    assert store.get(claim.job_id).listing["registration"]["reg_number_status"] == "unavailable"

def test_pending_registration_expires_to_unavailable(store_and_claim, clock):
    store, claim = store_and_claim
    store.complete(claim.job_id, claim.lease_token, listing_with(Registration.pending()), [], reveal_token="rt-1")
    assert store.get(claim.job_id).listing["registration"]["vin_status"] == "pending"
    clock.advance(seconds=121)
    reg = store.get(claim.job_id).listing["registration"]
    assert (reg["reg_number_status"], reg["vin_status"]) == ("unavailable", "unavailable")

def test_old_rows_without_reveal_columns_load(tmp_path):
    # Create the pre-change jobs table, insert one completed row, then open JobStore on it.
    ...
    assert JobStore(str(db), now).get("job-old").listing.get("registration") is None
```

Use the existing fixtures and fake clock in `tests/test_store.py`; add `store_and_claim`, `listing_with` and `FINAL` as small helpers there.

- [ ] **Step 2: Run them and confirm they fail.** Run: `docker run --rm --network none --pull=never -v "$PWD:/app:ro" -w /app -e PYTHONPATH=/app/src:/app/tests:/app --entrypoint python auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider tests/test_store.py tests/test_contracts.py`. Expected: the new tests fail.

- [ ] **Step 3: Implement.** Add `pending` to `FieldStatus`. Add nullable `reveal_token TEXT` and `reveal_until TEXT` to `jobs`, created for new tables and added with `ALTER TABLE ... ADD COLUMN` when missing. `set_registration` updates only `listing_json`'s `registration` key (and `job_reveals`) in one transaction, where `status = 'completed' AND reveal_token = ? AND reveal_until > now`, then sets `reveal_token = NULL`. `_record` rewrites each `pending` status to `unavailable` when `reveal_until` has passed or is `NULL`.

- [ ] **Step 4: Run the tests again.** Expected: pass, and the rest of `tests/test_store.py` still passes.

- [ ] **Step 5: Commit.** `git commit -m "feat: store a pending identity that the reveal fills in later"`

### Task 2: Storage endpoint and client call

**Files:**
- Modify: `src/auto24_service/storage_api.py`, `src/auto24_service/storage_client.py`
- Test: `tests/test_storage_api.py`, `tests/test_storage_client.py`

**Interfaces:**
- Consumes: `JobStore.complete(..., reveal_token=...)`, `JobStore.set_registration(...)` (Task 1)
- Produces: `POST /internal/jobs/{job_id}/registration` with body `{"reveal_token": str, "registration": Registration, "reveal_diagnostics": RevealDiagnostics | null}`, returning `{"updated": bool}`; same internal-key auth as `/complete`.
- Produces: `/complete` body gains optional `reveal_token`.
- Produces: `StorageClient.complete(job_id, lease_token, listing, warnings, reveal_diagnostics=None, *, diagnostic_omitted: int = 0, reveal_token: str | None = None) -> bool` (sends `reveal_token` only when set, like `diagnostic_omitted`) and `StorageClient.set_registration(job_id: str, reveal_token: str, registration: Registration, reveal_diagnostics: RevealDiagnostics | None) -> bool`

- [ ] **Step 1: Write the failing tests:** `test_registration_endpoint_requires_the_internal_key` (401 without it), `test_registration_endpoint_updates_once` (first call `updated: true`, second `false`), `test_client_set_registration_round_trip` (client against the test app; `get` then shows the final statuses).
- [ ] **Step 2: Run them and confirm they fail** with the Task 1 command on these two files.
- [ ] **Step 3: Implement** the route next to `complete_job` and the client method next to `complete`, reusing their validation and error handling.
- [ ] **Step 4: Run the tests.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: add the storage call that fills in a job's identity"`

### Task 3: Complete first, reveal afterwards

**Files:**
- Modify: `src/auto24_service/browser.py` (`capture_listing`), `src/auto24_service/worker.py` (`run_once`)
- Test: `tests/test_worker.py`, `tests/test_browser.py`

**Interfaces:**
- Consumes: `StorageClient.complete(..., reveal_token=...)`, `StorageClient.set_registration(...)` (Task 2), `Registration.pending()` (Task 1)
- Produces: `capture_listing(..., on_html: Callable[[str], bool] | None = None)`. Called once with the checked HTML before the reveal; when it returns `False`, the reveal is skipped and the session closes. After `on_html` returns `True`, the rest of the session (reveal and `browser_shutdown`) uses `NULL_OBSERVER`, because the lease ended at completion and spans would be rejected.
- Produces: `REVEAL_SECONDS` imported from `store.py` sets the reveal deadline: `time.monotonic() + REVEAL_SECONDS - LEASE_SAFETY_SECONDS`, measured from the `complete` call.

- [ ] **Step 1: Write the failing tests:**
  - `test_job_completes_before_the_reveal_runs`: a fake capture records call order; `client.complete` is called with both fields `pending` and a non-empty `reveal_token` before the fake reveal starts.
  - `test_reveal_result_is_posted_with_the_token`: after the reveal, `client.set_registration` receives the same token and the final `Registration`.
  - `test_parse_failure_fails_the_job_and_skips_the_reveal`: the parser raises; `client.fail` is called with `parse_failed` and the reveal never starts.
  - `test_superseded_completion_skips_the_reveal`: `client.complete` returns `False`; no reveal, no `set_registration`.
  - `test_listed_in_full_fills_in_right_after_completion`: fake reveal returns `listed_in_full` immediately; `set_registration` is called within 1 s of `complete`.
  - `test_reveal_logs_statuses_only`: caplog contains the statuses and never `123ABC`.
  - `test_timing_stops_at_completion`: with `diagnostics_enabled=True`, `record_spans` is never called after `complete`, `parsing` is still recorded, and `diagnostic_omitted` reaches `complete`.
- [ ] **Step 2: Run them and confirm they fail** (sandbox image, `tests/test_worker.py tests/test_browser.py`).
- [ ] **Step 3: Implement.** `run_once` passes an `on_html` that parses (inside the existing `parsing` phase), flushes and closes the recorder (`finish_diagnostics`), completes with `Registration.pending()`, a `secrets.token_urlsafe(16)` token and `_omitted_option(recorder)`, and returns the completion result. After `capture_listing` returns, call `set_registration` when a token was used. Keep the existing log line, now written after `set_registration`. Camoufox keeps working through the same path.
- [ ] **Step 4: Run** the two files, then `tests/test_extension_wait.py` and `tests/test_browser_chromium.py` in the Chromium test image. Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: complete the job first and fill in the identity after the reveal"`

### Task 4: Chromium as the default worker

**Files:**
- Modify: `compose.yaml`, `docs/local-development.md`, `docs/superpowers/service-roadmap.md`
- Test: `tests/test_compose_contract.py`

**Interfaces:**
- Produces: service `worker` builds `Dockerfile.chromium`, image `auto24-extraction-service:chromium`, `CAPTURE_ENGINE: ${CAPTURE_ENGINE:-chromium}`, `CHROMIUM_HEADLESS: ${CHROMIUM_HEADLESS:-false}`, and keeps `LIVE_DIAGNOSTICS_ENABLED`.
- Produces: service `worker-camoufox` under profile `camoufox` with the old `worker` definition and `CAPTURE_ENGINE: camoufox`. `worker-chromium` is removed.

- [ ] **Step 1: Write the failing tests:** `test_default_worker_runs_chromium` and `test_camoufox_worker_is_opt_in` (profile `camoufox`, never started by a plain `up`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the compose change, and update the commands in `docs/local-development.md` (`worker-chromium` becomes `worker`, Camoufox runs use `--profile camoufox worker-camoufox`) and the S2 status line in the roadmap.
- [ ] **Step 4: Run** `tests/test_compose_contract.py` and `tests/test_live_capture_script.py`, then `scripts/network-sandbox offline --engine chromium`. Expected: pass, and `contacted hosts: none`.
- [ ] **Step 5: Commit.** `git commit -m "feat: run the default worker on Chromium"`

**Checkpoint A stops here.** You run its "How to check" steps.

---

## Checkpoint B: Reg number and VIN on the listing page

### What you will see

The listing page appears as soon as the job completes. The reg number and VIN rows show a loading pulse, then the values (or "Not found"). The inspection report button waits for them, as `WAIT_FOR_IDENTITY` already intends. The report's facts include the revealed values.

### How to check

1. Start the app (`pnpm dev`) against the Checkpoint A stack.
2. Submit a listing with a hidden reg number on `/et`.
3. The listing card appears within a few seconds with pulses on both identity rows, and the report button is disabled with the "waiting" note.
4. Within about 30 s, the reg number (and VIN, if listed) replace the pulses and the report button enables.
5. Submit a listing with no VIN: the VIN row shows "Not found".
6. Open the report: the reg number and VIN appear in its facts.
7. Hide the tab while the pulses show and come back after 3 minutes: pending rows show "Not found", not a pulse.

### Before starting (Checkpoint B)

- [ ] Build only against "Shared contract" above. Use fake jobs in tests; a live check needs Checkpoint A running.
- [ ] The website treats `pending` past `parsed_at + 120 s` as `unavailable`, so a stuck service never leaves a pulse on screen.

### Task 5: Registration in the website's job contract

**Files:**
- Modify: `src/listings/contracts.ts`
- Test: `tests/listing-registration-compat.test.ts`

**Interfaces:**
- Produces: `registrationSchema` with `reg_number: string | null`, `reg_number_status`, `vin: string | null`, `vin_status`, `vin_format: "standard" | "nonstandard" | null`; status enum `listed_in_full | revealed | not_listed | unavailable | pending`. Values must be non-null exactly for `listed_in_full` and `revealed`.
- Produces: `listingSchema.registration: Registration | null`, default `null`. `export type Registration`.

- [ ] **Step 1: Rewrite the tests:** replace "accepts and drops registration" with `listing schema keeps registration`, add `pending registration parses`, `value without a value status is rejected`, and keep `job schema accepts and drops reveal_diagnostics` with `parsed.listing.registration` now kept.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/listing-registration-compat.test.ts` and confirm the rewritten tests fail.
- [ ] **Step 3: Implement** the schema in `contracts.ts`.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: keep the registration block in the listing contract"`

### Task 6: Identity on the card, polling until it settles

**Files:**
- Create: `src/features/listing/identity.ts`
- Modify: `src/features/listing/polling.ts`, `src/features/listing/dashboard.tsx`
- Test: `tests/unit/listing/identity.test.ts`, `tests/listing-polling.test.ts`, `tests/listing-dashboard-ui.test.ts`, `tests/unit/listing/report-gate.test.ts`

**Interfaces:**
- Consumes: `Registration` (Task 5), `ListingIdentity`, `IdentityField` (`report-gate.ts`)
- Produces: `listingIdentity(job: ListingJob | null, revealExpired: boolean): ListingIdentity | null`. `null` when the job is not completed or has no `registration`; `pending` maps to `{state: "pending"}` unless `revealExpired`, then `not_found`; `listed_in_full`/`revealed` to `found`; `not_listed`/`unavailable` to `not_found`.
- Produces: `identitySettled(job: ListingJob): boolean` (completed and no field `pending`).
- Produces: polling stops on `failed`, or on `completed` when `identitySettled`; otherwise it keeps polling at `POLL_INTERVAL_MS` until `parsed_at + REVEAL_SECONDS`, then stops and reports the reveal as expired.

- [ ] **Step 1: Write the failing tests:**
  - `listingIdentity`: one case per status, `test_job_without_registration_has_no_identity`, and the expired-pending case.
  - Polling: `keeps polling a completed job while a field is pending`, `stops once both fields settle`, `test_pending_identity_stops_at_the_reveal_deadline`.
  - Dashboard: the card renders the pulse for `pending`, the fake value `123ABC` for `revealed`, "Not found" for `not_listed`; the report button stays disabled while pending.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/listing/identity.test.ts tests/listing-polling.test.ts tests/listing-dashboard-ui.test.ts` and confirm the new tests fail.
- [ ] **Step 3: Implement** `identity.ts`, the polling stop rule, and pass `listingIdentity(job, revealExpired)` to `ListingCard` in place of `identity={null}` (`dashboard.tsx:312`). Treat `completed` with pending fields as not terminal for the card's `waiting` prop.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: show the reg number and VIN on the listing card"`

### Task 7: Revealed values in the report facts

**Files:**
- Modify: `src/listings/captured-job.ts`
- Test: `tests/captured-listing.test.ts`

**Interfaces:**
- Consumes: `listing.registration` (Task 5)
- Produces: a `vin` fact and a `registration plate` fact from `registration` when its status is `revealed` or `listed_in_full`, with `verification: 'unverified'` and `confidence: 0.9`. A fact with the same key from `other_fields` is replaced, not duplicated.

- [ ] **Step 1: Write the failing tests:** `revealed reg number becomes a fact`, `listed in full VIN becomes a fact`, `pending and not_listed add no fact`, `no duplicate when other_fields also has the VIN`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/captured-listing.test.ts` and confirm they fail.
- [ ] **Step 3: Implement** in `captured-job.ts` next to the existing `other_fields` facts.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: add revealed identity values to the report facts"`

**Checkpoint B stops here.** You run its "How to check" steps.

---

## Checkpoint C: Warm worker profile with automatic reset

### What you will see

Listings after the first one in a worker's life reveal in a few seconds, most without a CAPTCHA. The worker log shows `profile_jobs=<n>` per job and a `profile_reset reason=<count|age|blocked>` line when the profile is replaced. A benchmark `chromium/saved` run reports `no_captcha_needed` for most listings.

### How to check

1. Start the stack from Checkpoint A and submit 5 listings one after another on `/et`.
2. The first reveal takes about as long as before; the next ones mostly finish in under 5 s.
3. In `docker compose -p auto24 logs worker`, see `profile_jobs` count up from 1.
4. Run the benchmark twice with `--engine chromium --mode fresh saved --reveals 30` on your listings, then compare `chromium/saved` with `chromium/fresh` for speed, retries, `try_again_later` and capture errors.

### Before starting

- [ ] Record in the checkpoint doc's "Identity integration decisions": one persistent profile per worker; reset after 30 jobs, after 10 hours, and right after any `access_blocked` capture error or `try_again_later` reveal reason; the browser still starts and closes per job.

### Task 8: Persistent profile with reset rules

**Files:**
- Create: `src/auto24_service/warm_profile.py`
- Modify: `src/auto24_service/browser_chromium.py` (accept a kept profile), `src/auto24_service/worker.py`, `src/auto24_service/captcha_benchmark.py` (`chromium/saved` uses it)
- Test: `tests/test_warm_profile.py` (sandbox image), `tests/test_browser_chromium.py` (Chromium image), `tests/test_captcha_benchmark.py`

**Interfaces:**
- Produces: `WarmProfile(root: Path, *, max_jobs: int = 30, max_age_s: float = 36_000, clock=time.time)` with `path() -> Path` (creates or returns the current profile), `record(outcome: str | None) -> str | None` (counts a job; returns the reset reason `"count" | "age" | "blocked"` when it resets, else `None`), and `jobs: int`.
- Produces: `open_chromium_listing(..., keep_profile: Path | None = None)`. With a path, the session uses that folder, keeps it on exit, still copies a fresh WebSocket guard into it, and the startup sweep never removes it while its lock is free.
- Consumes: capture error codes and `RevealFailureReason` (`access_blocked`, `try_again_later`) as the blocked signals.

- [ ] **Step 1: Write the failing tests:**
  - `test_reset_after_30_jobs`, `test_reset_after_10_hours` (fake clock), `test_reset_right_after_a_block` (`access_blocked` and `try_again_later`), `test_reset_removes_the_old_folder`.
  - `test_kept_profile_survives_the_session_and_keeps_cookies` (Chromium image, fake site sets a cookie; a second session on the same path sees it).
  - `test_kept_profile_is_not_swept` and `test_concurrent_use_of_a_kept_profile_fails_closed` (`browser_launch`).
  - `test_chromium_saved_reuses_one_profile` in the benchmark tests.
- [ ] **Step 2: Run them and confirm they fail** (sandbox and Chromium images as in Task 1 and Task 3).
- [ ] **Step 3: Implement** `warm_profile.py`, the `keep_profile` path in the launcher, the worker wiring (log `profile_jobs` and `profile_reset reason`, statuses only), and `chromium/saved` in the benchmark, removing its "saved equals fresh" note.
- [ ] **Step 4: Run** the three test files, `tests/test_worker.py`, and `scripts/network-sandbox offline --engine chromium`. Expected: pass and `contacted hosts: none`.
- [ ] **Step 5: Commit.** `git commit -m "feat: keep a warm Chromium profile per worker with automatic resets"`

**Checkpoint C stops here.** You run its "How to check" steps and decide whether to keep it on.

---

## Outside the checkpoints (your tasks)

- Merge M4stas/kontroll#35, then M4stas/kontroll#47, before starting Task 1.
- On the x86_64 server: build the amd64 Chromium images, run the Chromium test subset and the offline sandbox, then 3 passing `chromium/fresh` benchmark runs.
- After Checkpoint C, decide whether to keep the warm profile on, based on the saved vs fresh benchmark runs.
