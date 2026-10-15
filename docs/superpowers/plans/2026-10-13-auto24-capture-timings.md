# Auto24 Capture Timings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Approved by the user on 2026-10-13 as [roadmap checkpoint 7](../roadmap.md#checkpoint-7-auto24-capture-timings). Start from `main` after the redesign merge in PR #32; this plan targets the redesigned listing page and report. When this checkpoint is done, stop. Later checkpoints each need their own approval.

**Goal:** Show the phases of each Auto24 capture in a Live diagnostics drawer on the listing page, and show the same capture timings in the report drawer.

**Architecture:** The extraction worker measures browser phases with an optional observer and posts the spans to the storage service from a background thread. The storage service checks each write against the active lease and stores the spans in a new Turso table. It also records queue waits, retry waits and result persistence itself. The public API exposes the spans read-only. Next.js proxies them to a listing drawer, and attaches them to the report drawer through `analysis_inputs.service_job_id`.

**Tech Stack:** Python 3 with FastAPI, Pydantic, Turso and Camoufox for the extraction service; Next.js 16, React, TypeScript and Zod for the application. No new dependency.

**Spec:** [Live diagnostics design](../specs/2026-10-09-live-diagnostics-design.md), the "Auto24 details", "Timing semantics" and "Data and access architecture" sections. The [diagnostics plan](2026-10-09-live-diagnostics.md) tasks 1, 2, 4 and 5 hold the extraction parts. Follow the [agent policy](../../agent-policy.md) for every dispatch.

## Global Constraints

- One flag, `LIVE_DIAGNOSTICS_ENABLED`, default `false`. In the app it gates the endpoints and the drawer. In the extraction service it gates collection. Pass it to the `storage` and `worker` compose services as `${LIVE_DIAGNOSTICS_ENABLED:-false}`. If it is off, no span rows are written and the service behaves exactly as before.
- Capture results, error codes, retry schedule (5 s, 30 s, at most 3 attempts), lease length (2 min) and capture security checks do not change. The existing tests in `tests/test_browser.py`, `tests/test_worker.py` and `tests/test_store.py` pass unchanged.
- Span rows hold only: span ID, job ID, attempt, phase, state, UTC start, UTC end, duration in ms, error code. No URLs, HTML, lease tokens, error messages or free text.
- Phases, in display order: `queue_wait`, `retry_wait`, `browser_start`, `page_setup`, `navigation`, `html_retrieval`, `validation`, `parsing`, `browser_shutdown`, `result_persistence`. States: `running`, `complete`, `failed`, `incomplete`. Error codes: `phase_failed`, `collection_incomplete`, or null.
- At most 64 spans per job. Writes beyond that are dropped and counted in `omitted`.
- Worker-measured durations use `time.monotonic()` in one process. `queue_wait` and `retry_wait` come from UTC timestamps the storage service already persists, and are labelled as waits.
- Diagnostic I/O never runs inside a measured phase. The worker waits at most 100 ms to flush before it calls `complete` or `fail`. A collector outage never changes a capture result or error.
- Browser-facing responses use `Cache-Control: private, no-store`. Flag off returns 404. A missing or invalid listing cookie returns 401.
- Overhead limit, unchanged from checkpoint 1: in each of five alternating enabled/disabled pairs, the enabled run adds at most 500 ms.
- Read `node_modules/next/dist/docs/` for route handlers before touching `src/app/`.
- UI follows `DESIGN.md` from the redesign: existing tokens, pill controls and the diagnostics drawer as it is. No new colors or components beyond the ones this plan names.

## Review Focus

- **An old Turso database file:** reopening a `jobs`-only database adds `diagnostic_spans` and keeps every job. Test in Task 1.
- **A stale worker after lease expiry:** its late span writes are rejected and cannot overwrite the next attempt's spans. Test in Task 1.
- **An extraction service that predates this checkpoint:** its diagnostics endpoint returns 404. The listing drawer and the report drawer say "Not recorded" and the report drawer still shows review data. Test in Task 4.
- **A report made from pasted text:** it has no `service_job_id`. The drawer says capture is not applicable and makes no service call. Test in Task 4.
- **A job ID in the URL that does not match the listing cookie:** returns 401 and never reaches the service. Test in Task 4.

---

### Task 1: Turso span storage and storage-owned waits

**Files:**
- Modify: `src/auto24_service/store.py`
- Modify: `src/auto24_service/contracts.py`
- Test: `tests/test_store.py`, `tests/test_contracts.py`

**Interfaces:**
- Produces in `contracts.py`: `CapturePhase` and `CaptureSpanState` Literals with the values from Global Constraints; `CaptureSpan(BaseModel)` with `span_id: str`, `attempt: int`, `phase: CapturePhase`, `state: CaptureSpanState`, `started_at: datetime`, `completed_at: datetime | None`, `duration_ms: float | None`, `error_code: Literal["phase_failed", "collection_incomplete"] | None`. Times serialize as UTC `Z` strings, like `JobResponse`. `CaptureDiagnostics(BaseModel)` with `job_id: str`, `collection: Literal["enabled", "disabled"]`, `spans: list[CaptureSpan]`, `omitted: int`.
- Produces in `store.py`: `JobStore(db_path, now, *, diagnostics_enabled: bool = False, monotonic=time.monotonic)`; `record_spans(job_id: str, lease_token: str, spans: list[CaptureSpan]) -> bool`; `diagnostics(job_id: str) -> CaptureDiagnostics | None`.

- [x] **Step 1: Write the failing tests** in `tests/test_store.py`:
  - `test_reopening_jobs_only_database_adds_spans_and_keeps_jobs`: create a database with the current `jobs` DDL and one row, open `JobStore` on it, and assert the row is unchanged and `diagnostics(job_id).spans == []`.
  - `test_first_claim_records_queue_wait_from_submission`: with `diagnostics_enabled=True`, create at 12:00:00 and claim at 12:00:03. Assert one `queue_wait` span, attempt 1, state `complete`, `duration_ms == 3000`.
  - `test_transient_failure_records_retry_wait_and_next_queue_wait`: fail at 12:00:10 with `transient=True`, then claim at 12:00:20. Assert a `retry_wait` span for attempt 1 with `duration_ms == 5000`, and a `queue_wait` span for attempt 2 that starts at `retry_at` (12:00:15) with `duration_ms == 5000`.
  - `test_reclaim_after_lease_expiry_measures_wait_from_lease_end`: claim, let the lease expire, claim again. The attempt 2 `queue_wait` starts at the old `lease_until`.
  - `test_record_spans_requires_active_lease`: a wrong token, an expired lease, or a completed job returns `False` and writes nothing.
  - `test_record_spans_upserts_by_span_id_and_keeps_other_attempts`: write a span as `running`, then as `complete`. One row remains. An attempt 2 write with a new span ID leaves attempt 1 rows unchanged.
  - `test_spans_capped_at_64_per_job`: 70 writes store 64 and `omitted == 6`.
  - `test_complete_records_result_persistence`: inject a fake `monotonic` that advances 12 ms across the completion transaction. Assert a `result_persistence` span with `duration_ms == 12`. If the span insert raises, `complete` still returns `True` and the job is completed.
  - `test_diagnostics_disabled_writes_nothing`: with the default flag, claims, fails, completes and `record_spans` write no rows, and `diagnostics()` returns `collection == "disabled"`.
  - In `tests/test_contracts.py`, `test_capture_span_rejects_unknown_phase_and_negative_duration`.

- [x] **Step 2: Run them and confirm they fail**

Run: `python -m pytest tests/test_store.py tests/test_contracts.py -q`
Expected: FAIL on the new tests (missing `record_spans`, `diagnostics`, `CaptureSpan`).

- [x] **Step 3: Implement the storage**

Add `CREATE TABLE IF NOT EXISTS diagnostic_spans (span_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_ms REAL, error_code TEXT)` and an index on `(job_id, started_at)`. Add a `diagnostic_omitted INTEGER NOT NULL DEFAULT 0` column to `jobs` only through `ALTER TABLE ... ADD COLUMN` when it is missing, and keep it out of `_JOB_COLUMNS` and `JobRecord`. Upsert with `INSERT ... ON CONFLICT(span_id) DO UPDATE` only when the stored row has the same `job_id` and `attempt`. Write the claim and retry spans inside the existing claim and fail transactions, so they commit together with the job update. To know when a job became eligible, read `submitted_at`, `retry_at` or `lease_until` before the update clears them. Write `result_persistence` after the completion commit in its own `try` block that ignores errors.

- [x] **Step 4: Run all store and contract tests**

Run: `python -m pytest tests/test_store.py tests/test_contracts.py -q`
Expected: PASS, including every test that existed before.

- [x] **Step 5: Commit**

```bash
git add src/auto24_service/store.py src/auto24_service/contracts.py tests/test_store.py tests/test_contracts.py
git commit -m "feat(extraction): store lease-checked capture timing spans"
```

### Task 2: Storage and public routes, storage client

**Files:**
- Modify: `src/auto24_service/storage_api.py`, `src/auto24_service/storage_client.py`, `src/auto24_service/public_api.py`, `compose.yaml`
- Test: `tests/test_storage_api.py`, `tests/test_storage_client.py`, `tests/test_public_api.py`, `tests/test_compose_contract.py`

**Interfaces:**
- Consumes: `JobStore.record_spans`, `JobStore.diagnostics`, `CaptureSpan`, `CaptureDiagnostics` from Task 1.
- Produces: `POST /internal/jobs/{job_id}/diagnostics` with body `{lease_token, spans: CaptureSpan[] (max 16)}` returning `{"updated": bool}`; `GET /internal/jobs/{job_id}/diagnostics` returning `CaptureDiagnostics` or 404; `StorageClient.record_spans(job_id, lease_token, spans, *, timeout: float) -> bool`; `StorageClient.diagnostics(job_id) -> CaptureDiagnostics | None`; public `GET /v1/jobs/{job_id}/diagnostics` returning `CaptureDiagnostics` (404 for an unknown job, 503 when storage is down).

- [ ] **Step 1: Write the failing tests**
  - `test_storage_diagnostics_routes_require_internal_key`: both routes return 401 without the key.
  - `test_storage_record_spans_rejects_more_than_16_spans`: returns 422.
  - `test_public_diagnostics_never_contains_lease_token_or_url`: claim a job, record spans, fetch `/v1/jobs/{id}/diagnostics`, and assert the response text contains neither the lease token nor `auto24.ee`.
  - `test_public_diagnostics_unknown_job_is_404` and `test_public_diagnostics_storage_down_is_503`.
  - `test_storage_client_record_spans_uses_short_timeout`: through a mock transport, assert the request's timeout extension equals the `timeout` argument.
  - `test_compose_passes_diagnostics_flag_to_storage_and_worker` in `tests/test_compose_contract.py`.
  - `test_storage_app_reads_diagnostics_flag`: `create_runnable_storage_app` builds `JobStore` with `diagnostics_enabled=True` when `LIVE_DIAGNOSTICS_ENABLED=true`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `python -m pytest tests/test_storage_api.py tests/test_storage_client.py tests/test_public_api.py tests/test_compose_contract.py -q`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the routes and client methods** in the files above, following the existing `complete`/`fail` patterns. The public route reuses the existing API-key middleware. Add the flag to the `storage` and `worker` environments in `compose.yaml`.

- [ ] **Step 4: Run the Python suite**

Run: `python -m pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auto24_service/storage_api.py src/auto24_service/storage_client.py src/auto24_service/public_api.py compose.yaml tests/test_storage_api.py tests/test_storage_client.py tests/test_public_api.py tests/test_compose_contract.py
git commit -m "feat(extraction): expose capture timings through private routes"
```

### Task 3: Browser phase observer and worker recorder

**Files:**
- Create: `src/auto24_service/diagnostics.py`
- Modify: `src/auto24_service/browser.py`, `src/auto24_service/worker.py`
- Test: `tests/test_diagnostics.py`, `tests/test_browser.py`, `tests/test_worker.py`

**Interfaces:**
- Consumes: `StorageClient.record_spans` from Task 2, `CaptureSpan` from Task 1.
- Produces in `diagnostics.py`: `class PhaseObserver(Protocol)` with `phase(name: CapturePhase) -> ContextManager[None]`; `NULL_OBSERVER`; `class SpanRecorder(PhaseObserver)` built with `SpanRecorder(write: Callable[[list[CaptureSpan]], bool], *, job_id, attempt, monotonic=time.monotonic, now=utc_now, max_pending=64)`, with `flush(deadline_seconds: float = 0.1) -> None` and `close() -> None`.
- Produces in `browser.py`: `capture_html(url: str, observer: PhaseObserver = NULL_OBSERVER) -> str`. Its default call signature and return value stay the same.
- Produces in `worker.py`: `run_once(client, capture, parser, *, diagnostics_enabled: bool = False)`. `CaptureHTML` becomes `Callable[[str, PhaseObserver], str]`. Existing test lambdas that take one argument still work when diagnostics are off, because the worker then calls `capture(url)` the old way.

- [ ] **Step 1: Write the failing tests**
  - `tests/test_diagnostics.py`:
    - `test_phase_records_running_then_complete_with_monotonic_duration`: a fake clock advances 250 ms, giving `duration_ms == 250`.
    - `test_phase_marks_failed_and_reraises_original_error`.
    - `test_write_runs_off_the_calling_thread`: a write that blocks for 1 s does not delay the `with` block's exit by more than 50 ms.
    - `test_flush_waits_at_most_deadline`: a hanging writer returns from `flush(0.1)` within 150 ms, and the unsent spans are counted as omitted.
    - `test_writer_exception_never_reaches_caller`.
    - `test_queue_full_drops_and_counts`: more than `max_pending` spans are dropped and counted.
  - `tests/test_browser.py`:
    - `test_capture_reports_phases_in_order`: using the file's existing fake Camoufox setup, a recording observer sees `browser_start, page_setup, navigation, html_retrieval, validation, browser_shutdown`.
    - `test_navigation_failure_marks_navigation_failed_and_still_shuts_down`: the observer sees `navigation` failed and `browser_shutdown` complete, and `CaptureError("temporary_failure")` is raised as before.
    - `test_listing_gone_marks_validation_failed`.
  - `tests/test_worker.py`:
    - `test_worker_records_parsing_and_flushes_before_complete`: the fake client records the order of calls. Every `record_spans` call comes before `complete`, and a `parsing` span is complete.
    - `test_worker_capture_result_identical_when_span_writes_fail`: `record_spans` raises `StorageUnavailableError`, and the job still completes with the same listing.
    - `test_worker_without_diagnostics_never_calls_record_spans`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `python -m pytest tests/test_diagnostics.py tests/test_browser.py tests/test_worker.py -q`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`SpanRecorder` puts spans on a bounded `queue.Queue` and drains it in one daemon thread in batches of up to 16. Each `phase()` sends a `running` span on entry and the final span on exit, with the same `span_id`. In `capture_html`, replace `with Camoufox(...) as browser` with an explicit `__enter__` inside `browser_start` and `__exit__` inside `browser_shutdown` in a `finally`. Wrap `new_context`, `new_page` and route setup in `page_setup`, the redirect loop in `navigation`, each `page.content()` in `html_retrieval`, and the status, URL and page error checks in `validation`. Exceptions and their mapping stay exactly as they are. In `run_once`, build the recorder after `claim()` and bind it to `claim.job_id` and `claim.attempts`. Wrap `parser(...)` in `parsing`. Call `recorder.flush(0.1)` immediately before `_fail` or `client.complete`, then `close()`. The writer calls `client.record_spans(..., timeout=1.0)`. `main()` reads `LIVE_DIAGNOSTICS_ENABLED`.

- [ ] **Step 4: Run the Python suite**

Run: `python -m pytest -q`
Expected: PASS, with every capture security test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/auto24_service/diagnostics.py src/auto24_service/browser.py src/auto24_service/worker.py tests/test_diagnostics.py tests/test_browser.py tests/test_worker.py
git commit -m "feat(extraction): measure Auto24 capture phases"
```

### Task 4: Application read path for capture timings

**Files:**
- Modify: `src/diagnostics/contracts.ts`, `src/listings/auto24-service.ts`, `src/server/repositories/diagnostics.ts`, `src/diagnostics/project.ts`
- Create: `src/features/diagnostics/load-capture-diagnostics.ts`, `src/app/api/listings/[jobId]/diagnostics/route.ts`
- Test: `tests/unit/diagnostics/contracts.test.ts`, `tests/unit/diagnostics/capture-routes.test.ts`, `tests/unit/diagnostics/project.test.ts`

**Interfaces:**
- Consumes: public `GET /v1/jobs/{job_id}/diagnostics` from Task 2.
- Produces in `contracts.ts`: `CapturePhaseSchema`; `CaptureSpanSchema` (camelCase: `id`, `attempt`, `phase`, `state`, `startedAt`, `completedAt`, `durationMs`, `errorCode`, strict); `CaptureTimingsSchema = { availability: "available" | "unavailable" | "not_recorded" | "not_applicable" | "disabled", spans: CaptureSpan[] (max 64), omitted: number }`; `CaptureDiagnosticsSnapshotSchema = { version: 1, serverNow, jobId, status: "queued" | "running" | "completed" | "failed", capture: CaptureTimings }`. `DiagnosticsSnapshotSchema` gets an optional `capture: CaptureTimingsSchema` field.
- Produces in `auto24-service.ts`: `serviceDiagnosticsRequest(jobId: string): Promise<CaptureTimings>`. It maps HTTP 404 to `not_recorded` and network, 5xx or schema failure to `unavailable`, and converts snake_case to camelCase. A service response with `collection: "disabled"` maps to `disabled`.
- Produces: `loadCaptureDiagnostics({ jobId, cookie }, deps?) -> CaptureDiagnosticsSnapshot`, which throws `DiagnosticsAccessError(404 | 401)` like `loadDiagnostics`; `GET /api/listings/[jobId]/diagnostics`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/diagnostics/capture-routes.test.ts`:
  - `flag off returns 404 before any service call`.
  - `missing or mismatched listing cookie returns 401 and makes no service call`: use a cookie that was signed for a different job ID.
  - `responses are private no-store`.
  - `service 404 maps to not_recorded; service 503 maps to unavailable; job status is still returned`.
  - `payload with a url or lease_token key is rejected by the strict schema` (contracts test).

  Add to `tests/unit/diagnostics/project.test.ts`:
  - `report snapshot includes capture timings for a captured listing`.
  - `pasted-text report has capture not_applicable and makes no service call`.
  - `capture fetch failure leaves reviews intact and marks capture unavailable`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/unit/diagnostics`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

The listing route follows `src/app/api/listings/[jobId]/route.ts` for cookie checks and the analysis diagnostics `handler.ts` for headers and error bodies. `DiagnosticsRepository.load` reads the newest `analysis_inputs` row for the analysis (same query as `src/server/repositories/analyses.ts:474-479`). It calls `serviceDiagnosticsRequest` only when `service_job_id` is a string, and runs the call in the existing `Promise.all`. The service job ID is resolved only on the server and never accepted from the browser.

- [ ] **Step 4: Run the unit suite and typecheck**

Run: `npm test -- tests/unit/diagnostics && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics src/listings/auto24-service.ts src/server/repositories/diagnostics.ts src/features/diagnostics/load-capture-diagnostics.ts "src/app/api/listings/[jobId]/diagnostics" tests/unit/diagnostics
git commit -m "feat(diagnostics): read Auto24 capture timings for listings and reports"
```

### Task 5: Listing drawer and capture timeline UI

**Files:**
- Create: `src/features/diagnostics/capture-timings.tsx`, `src/features/diagnostics/diagnostics-drawer.tsx`, `src/features/diagnostics/listing-diagnostics-panel.tsx`, `src/features/diagnostics/poll-loop.ts`
- Modify: `src/features/diagnostics/diagnostics-panel.tsx`, `src/features/diagnostics/use-diagnostics.ts`, `src/features/listing/dashboard.tsx`, `src/app/[locale]/a/[jobId]/page.tsx`, `src/app/[locale]/globals.css`, `messages/en.json`, `messages/et.json`
- Test: `tests/unit/diagnostics/capture-timings.test.tsx`, `tests/unit/diagnostics/polling.test.tsx`, `tests/unit/diagnostics/panel.test.tsx`

**Interfaces:**
- Consumes: `CaptureTimings`, `CaptureDiagnosticsSnapshotSchema` and `GET /api/listings/[jobId]/diagnostics` from Task 4.
- Produces: `startPollLoop({ fetchOnce: (signal) => Promise<void>, isActive: () => boolean, onFailure: () => void }) -> { stop(), retry() }`, which holds the current 3 s interval, single in-flight request, hidden/closed pause, and 6/12/30 s backoff. `useDiagnostics` keeps its current API and behavior and uses the loop. `DiagnosticsDrawer({ title, triggerClassName?, children })` is the existing dialog shell, with the trigger button, Escape handling and focus return. The report keeps its two existing triggers, in the review progress actions (`src/features/report/report-progress.tsx`) and in the evidence row (`src/features/report/evidence-row.tsx`), with unchanged markup. `CaptureTimings({ capture, serverNow })` groups spans by attempt and shows phases in the Global Constraints order. Running phases show elapsed time from `serverNow`, waits are labelled as waits, and the omitted count and availability are shown in text. `ListingDiagnosticsPanel({ jobId, enabled })`.

- [ ] **Step 1: Write the failing tests**
  - `tests/unit/diagnostics/capture-timings.test.tsx`:
    - `renders phases in fixed order grouped by attempt`.
    - `labels queue and retry waits separately from work`.
    - `running phase shows elapsed time from serverNow`.
    - `failed phase shows failed state`.
    - `each availability value renders its own text, with not_recorded reading "Not recorded"`.
    - `renders in Estonian`.
  - `tests/unit/diagnostics/polling.test.tsx`: keep every existing case passing, and add `listing panel polls /api/listings/{jobId}/diagnostics every 3 s only while open and visible`.
  - `tests/unit/diagnostics/panel.test.tsx`: `report drawer shows capture timings above photo reviews` and `report drawer says capture not applicable for pasted text`.
  - `tests/listing-dashboard-ui.test.ts`: `listing card shows Live diagnostics below the report button when enabled`, `failed capture section shows Live diagnostics when enabled`, and `no diagnostics trigger when disabled`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- tests/unit/diagnostics`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

Extract the dialog and polling code from `DiagnosticsPanel` without changing its markup or classes, then build the listing panel from the same parts. `ListingPage` passes `diagnosticsEnabled={isLiveDiagnosticsEnabled()}` to `ListingDashboard`. On the redesigned page it renders `ListingDiagnosticsPanel` in two places: inside the sticky `ListingCard`, as the last child after `ReportActions`, and inside the `listing-failed` section after `ReportActions`, because a failed capture is where the timings help most. The trigger uses the secondary pill style already used on the page, through `triggerClassName`; add only a spacing rule to `globals.css` if needed. It must not push the report button out of the card's first screen at 1280×800. Add the strings under `Diagnostics.capture` in both message files. The phase labels are: Queue wait, Retry wait, Browser start, Page setup, Page load, HTML retrieval, Page checks, Parsing, Browser shutdown, Saving result. Write the Estonian versions in the same plain style as the existing `Diagnostics` strings.

- [ ] **Step 4: Run the full gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/diagnostics src/features/listing/dashboard.tsx "src/app/[locale]/a/[jobId]/page.tsx" messages/en.json messages/et.json tests/unit/diagnostics
git commit -m "feat(diagnostics): show Auto24 capture phases on the listing page"
```

### Task 6: Overhead measurement, acceptance and PR

**Files:**
- Create: `scripts/measure_capture_overhead.py`, `docs/superpowers/checkpoints/2026-10-13-auto24-capture-timings.md`
- Modify: `docs/local-development.md`, `docs/superpowers/roadmap.md`

- [ ] **Step 1: Write the overhead script**

The script runs `worker.run_once` against an in-process storage app with a temporary Turso file. It uses a fake `capture` that runs all six browser phases with fixed sleeps (1.0 s in total) and the real parser on `tests/fixtures/auto24-passenger-car.html`. It runs five pairs and alternates which run goes first. It prints each pair's enabled and disabled wall times, the difference, the maximum difference, and whether both runs ended in the same state with the same listing JSON.

- [ ] **Step 2: Run it**

Run: `python scripts/measure_capture_overhead.py`
Expected: every pair's difference is at most 500 ms and every outcome is identical. Paste the output into the checkpoint evidence file.

- [ ] **Step 3: Check it in the running app.** Rebuild the extraction containers with `LIVE_DIAGNOSTICS_ENABLED=true`, start the app and the worker, and follow the roadmap's "How to check" steps. Use a listing the user chooses; do not submit listings seen in the browser on your own initiative. For the retry case, pause the worker container during a capture for more than 2 minutes with `docker compose pause worker`, then resume it. Attempt 1 is left with incomplete phases, and attempt 2 shows its queue wait starting at the lease end. For the unavailable-storage case, restart only `storage` with the flag off. The worker's span writes are rejected, the capture still completes, and the drawer shows timings as off.

- [ ] **Step 4: Get an independent review under the agent policy**, including the final review for concurrency and privacy. Fix the findings and repeat the affected checks.

- [ ] **Step 5: Do manual E2E under the agent policy.** Cover desktop and mobile, English and Estonian, the listing drawer before the report exists, the report drawer afterwards, an older listing ("Not recorded"), a pasted-text report, the flag off, and a wrong cookie.

- [ ] **Step 6: Document and open the PR.** Add the flag's effect on the extraction containers and the rebuild step to `docs/local-development.md`. Record the evidence. In the roadmap, set checkpoint 7 to "PR open; user acceptance pending". Open the PR with the `/pr` skill and stop.

## How to check (for the user, after the PR)

1. Set `LIVE_DIAGNOSTICS_ENABLED=true` in `.env.local` and in the shell that runs `docker compose`. Rebuild and restart the extraction containers, then start the app and the worker.
2. Submit an Auto24 listing and press Live diagnostics in the listing card, under the report button, straight away. Phases appear as they finish, starting with the queue wait.
3. Submit a link to a listing that no longer exists. The failed capture page has Live diagnostics, and its page checks phase shows as failed.
4. Create the report. Open Live diagnostics from the review progress screen, then from the evidence row under the cards. Both show the same capture timings above the photo timings.
5. Open a listing captured before this checkpoint. It says "Not recorded".
6. Read the overhead results in the checkpoint evidence file.
