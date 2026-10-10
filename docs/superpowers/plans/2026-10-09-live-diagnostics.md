# Live Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, live diagnostics drawer showing capture and review timings and committed intermediate results.

**Architecture:** Reuse durable review execution/attempt records and current report access. Add additive timing storage at the extraction and application boundaries, project it through private endpoints, and poll only while the drawer is visible. Keep the existing review coordinator and final publication barrier authoritative.

**Tech Stack:** Existing Node 24, Next.js/React, TypeScript/Zod, Supabase/Postgres, Python/FastAPI, and Turso. No new runtime dependency.

**Spec:** [Live diagnostics design](../specs/2026-10-09-live-diagnostics-design.md).

## Global constraints

- Checkpoint 1 completed in [PR #14](https://github.com/M4stas/kontroll/pull/14), with clean independent review and manual E2E. Checkpoints 2 and 3 remain pending.
- Follow [agent policy](../../agent-policy.md); do not edit it or its worktree copies.
- Enable with an explicit server-only `LIVE_DIAGNOSTICS_ENABLED=true` setting; default false.
- Every request requires the existing listing/report cookie. Use private, no-store responses.
- Use Node 24 and existing dependencies. Keep reviewer settings, immutable records, concurrency, retry rules, and report publication behavior unchanged.
- Migrations are additive. Preserve existing data; use disposable databases for integration tests.
- No provider reasoning, prompts, credentials, signed URLs, storage keys, raw output, or document contents in timing/export payloads.
- Current repo base for execution is the latest descendant of `codex/image-review-performance` after checking PR/dependency status. Primary checkout is an older extraction-only branch.
- Each checkpoint requires its own PR, clean independent subagent code review, and clean manual frontend E2E. Fix issues and repeat affected checks before declaring that checkpoint complete.

## Delivery checkpoints

Implement in checkpoint order, not Task 1 through Task 6 order. The tasks below describe work packages shared across checkpoints; execute only the portions assigned to the current checkpoint. Do not front-load all telemetry storage before delivering the first visible panel. Each checkpoint builds on the previous one, remains usable independently, and ends with a browser demo and its own attached PR. If the preceding PR is unmerged, declare the PR dependency explicitly.

### Checkpoint 1: Live review panel

**Visible result:** Open Live diagnostics on a private report and watch text, photos, and final assessment progress. Expand a completed photo to read its saved findings and attempt duration while other photos are still running.

**Scope:** Reuse existing review audits, snapshots, and job/lease state. Add the feature flag, finite read contracts, current-run projection, report diagnostics/results endpoints, drawer, polling, and review cards. Show elapsed attempt time, attempt history, safe model settings, provisional results, and reused-result provenance. No new timing tables, worker instrumentation, extraction-service changes, earlier-run picker, PDF processing breakdown, or export in this checkpoint. Missing internal timings say Not recorded.

**Work packages:** Task 1 read DTOs/config only; Task 3 projection/repository only; Task 4 report endpoints and access tests only; Task 5 report drawer/polling/cards only; Task 6 applicable verification/documentation/review/PR. Keep these parts independent of future span tables and extraction endpoints. Define optional measurement fields now rather than implementing unused persistence.

- [x] Deliver the authorized current-run read APIs and report drawer using existing data.
- [x] Demo a controlled four-photo run with three photos active at most, out-of-order results shown in manifest order, findings appearing only after commit, and final review waiting for its existing barrier.
- [x] Demo text/final attempt durations, retry history, zero findings, refresh, offline/reconnect, expired lease, and reuse labels without negative/new-call durations. Basic PDF-run discovery must avoid stale results even though dedicated PDF views come in checkpoint 3.
- [x] Complete desktop/mobile and English/Estonian manual E2E, access/feature-disabled checks, relevant automated checks, clean independent subagent review, sanitized demo evidence, and an attached checkpoint-1 PR.

**Done means:** The user can submit a review, open the drawer, watch it progress, and inspect each saved photo result. No terminal access is needed for this workflow.

### Checkpoint 2: Detailed capture timings

**Visible result:** Open the drawer on the listing dashboard before a report exists. Watch Auto24 phases progress, then inspect the same capture and application photo-preparation timings from the resulting report.

**Scope:** Add additive Supabase/Turso timing storage, lease-checked best-effort collectors, Auto24 phase instrumentation, application stage/photo-preparation and reviewer-adapter timing, listing diagnostics endpoint, capture-to-report correlation, and nested timeline UI. Separate queue waits, retry delays, overlapping image work, and completed phase durations. Dedicated PDF-request instrumentation remains checkpoint 3.

**Work packages:** Task 1 remaining storage/Python contracts; Task 2 extraction instrumentation; Task 3 recorder and non-PDF instrumentation; Task 4 listing/extraction projection and span pagination; Task 5 dashboard entry and detailed timeline; Task 6 applicable verification/documentation/review/PR.

- [ ] Deliver additive storage and instrumentation with historical/old-service compatibility, safe failure handling, and migration preservation proof.
- [ ] Demo queue wait, browser startup/setup, navigation, HTML retrieval/validation, parsing, shutdown, and result persistence. Show photo download/validation/normalization/upload and reviewer preparation separately.
- [ ] Demo a failed/retried phase and unavailable collector; confirm the drawer identifies the measured wait while review behavior remains unchanged. Verify parallel/parent-child timings are not double-counted.
- [ ] Compare controlled diagnostics-enabled/disabled runs for added overhead and unchanged provider-call counts. Record the actual measurements.
- [ ] Complete desktop/mobile and English/Estonian manual E2E, migration/privacy/concurrency review as applicable, relevant automated checks, sanitized demo evidence, and an attached checkpoint-2 PR.

**Done means:** The user can point to the measured stage or photo responsible for a wait, including time spent before the report was created. Unknown measurements remain explicit.

### Checkpoint 3: Complete diagnostic workflow

**Visible result:** Upload a taustakontroll PDF, watch its processing and final reassessment, compare previous/current final results, select earlier runs, and download a timing report.

**Scope:** Add PDF request-processing spans tied to accepted submissions, dedicated PDF update/reuse view, earlier-run picker with pagination, and timing-only JSON export. Complete remaining cross-run/reconnection interactions; basic failure, access, mobile, and offline support must already work in earlier checkpoints.

**Work packages:** Task 3 PDF instrumentation; Task 4 earlier-run paging/result provenance; Task 5 run selection, PDF comparison and export; Task 6 full integrated verification/documentation/review/PR. Previous/current observation comparison is literal; semantic added/changed/removed classification remains outside scope.

- [ ] Deliver PDF validation/text-extraction/upload timings without creating a fake run for a rejected upload or accepting client-supplied timing values.
- [ ] Demo a PDF-only update showing reused text/images, exactly one new final assessment, original result timestamps, and previous/current final results. Switch runs while requests are in flight and confirm no results leak into the wrong view.
- [ ] Demo export of measured durations/counts/settings and availability indicators; inspect the file to confirm it excludes findings/document text, photos, URLs, capabilities, and secrets.
- [ ] Verify refresh, worker restart, superseded run, network loss/reconnect, partial telemetry, historical records, and feature-disabled behavior across the completed workflow.
- [ ] Complete full automated gates, desktop/mobile and English/Estonian manual E2E, clean independent subagent review, sanitized demo evidence, documentation, and an attached checkpoint-3 PR.

**Done means:** The user can inspect and export a complete listing-review session, including its PDF update and earlier runs, without reading logs.

### Checkpoint handoff

At each checkpoint, provide its PR link, a short demo with visible outcomes, verification evidence, and the exact scope still pending. Mark the checkpoint complete only after all its gates pass. Stop after the authorized checkpoint. Finishing checkpoint 1 does not authorize checkpoints 2 or 3.

## Execution preparation

- [ ] Re-read spec, inspect current branch/PR status and applicable AGENTS files, and choose an isolated implementation worktree using the worktree skill. Preserve all existing dirty files and live services.
- [ ] Read installed Next.js documentation before framework edits. Inspect latest telemetry and capture APIs to avoid duplicating changes made after this plan.
- [ ] Record exact baseline commit and required migrations in the implementation PR. Use a separate app port and disposable Supabase/Auto24 stack for controlled tests. Never consume the live user's unrelated queue.

## Task 1: Define diagnostic contracts and additive storage

Checkpoint allocation: read contracts/config in checkpoint 1; new storage, migrations, RPCs, and Python contracts in checkpoint 2.

Files to create: `src/diagnostics/contracts.ts`, `src/auto24_service/diagnostics.py`, `supabase/migrations/202610090001_diagnostic_spans.sql`, `supabase/rollbacks/202610090001_diagnostic_spans.sql`, `tests/unit/diagnostics/contracts.test.ts`, `tests/integration/diagnostic-spans.test.ts`, `tests/test_diagnostics.py`.
Files to modify: `src/auto24_service/store.py`, `src/auto24_service/storage_api.py`, `src/auto24_service/storage_client.py`, `src/config/application.ts`, `.env.example`.

Interfaces: `DiagnosticSpan` has `id`, `parentId`, `phase`, `jobId`, `runId`, `attempt`, `evidenceId`, `startedAt`, `completedAt`, `durationMs`, `state`, `errorCode`; irrelevant owner fields are nullable. `DiagnosticsSnapshot` has `version: 1`, `serverNow`, `owner`, `runs`, `stages`, `reviews`, `spans`, `availability`, `nextCursor`. Review projections contain safe pinned settings and result availability, never full snapshot JSON. Define shared finite phase/state enums before instrumentation consumes them.

- [ ] Add failing tests for nonnegative durations, finished/start state consistency, invalid phase/error codes, oversized payloads, and feature default false.
- [ ] Add migration tests proving browser roles cannot read/write spans, stale leases cannot append/finish spans, owner mismatch is rejected, parent ownership matches, and owner deletion cascades. Verify old rows survive migration/rollback-code compatibility.
- [ ] Add equivalent Turso reopen/persistence and active lease validation tests. Keep this a new table rather than changing existing job-row result fields.
- [ ] Implement only the schema, finite DTOs, internal storage methods/routes, and lease-checked RPCs required by the tests. Store UTC starts and monotonic completed duration separately. Enforce bounded rows per owner/attempt.
- [ ] Run focused unit/Python and disposable integration tests, inspect migration diff, and commit the independently working storage contract.

## Task 2: Instrument extraction phases and expose safe measurements

Checkpoint allocation: checkpoint 2 only.

Files to modify: `src/auto24_service/browser.py`, `src/auto24_service/worker.py`, `src/auto24_service/public_api.py`, `src/auto24_service/storage_api.py`, `src/auto24_service/storage_client.py`.
Files to test: `tests/test_browser.py`, `tests/test_worker.py`, `tests/test_public_api.py`, `tests/test_storage_api.py`, `tests/test_store.py`, `tests/test_diagnostics.py`.

Interfaces: optional phase observer to `capture_html` preserves its existing default caller signature and return value. Observer receives allowlisted start/finish records; worker binds job/attempt ownership. `GET /v1/jobs/{job_id}/diagnostics` returns only safe timing DTOs under existing API-key protection. Client `get_diagnostics(job_id)` reads it without exposing the internal lease token.

- [ ] Add fake-clock tests covering browser launch/setup, permitted redirects, navigation failure, HTML retrieval/validation, parser failure, shutdown, and persistence failure; assert each completed duration and terminal state. Existing capture-security tests must remain unchanged and passing.
- [ ] Test capture retries retain separate attempts and queue/retry waits; late superseded workers cannot overwrite current measurements.
- [ ] Implement best-effort observers with short timeouts and bounded pending writes; capture/parser behavior must be identical when diagnostics are disabled or the collector fails.
- [ ] Measure result persistence inside the storage-owned completion operation. Return its committed timing as part of diagnostics without requiring a worker write after the lease ends. Persist completion telemetry separately with best-effort failure handling, and never reopen the completed job or change its result.
- [ ] Test new diagnostic endpoint auth, safe projection, unknown job, and old-job Not recorded behavior. Run focused Python tests and commit.

## Task 3: Instrument application work and assemble diagnostics

Checkpoint allocation: existing audit projection/repository in checkpoint 1; non-PDF recorder/instrumentation in checkpoint 2; PDF request instrumentation in checkpoint 3.

Files to create: `src/diagnostics/recorder.ts`, `src/server/repositories/diagnostics.ts`, `src/diagnostics/project.ts`, `tests/unit/diagnostics/recorder.test.ts`, `tests/unit/diagnostics/project.test.ts`.
Files to modify: `src/worker/process-job.ts`, `src/analysis/pipeline.ts`, `src/listings/photos.ts`, `src/server/storage/uploads.ts`, `src/server/storage/pdf-text.ts`, `src/features/supplements/add-submission.ts`, `src/insights/codex.ts`, `scripts/worker.ts`.

Interfaces: `recordPhase(context, phase, work)` records a span around a promise, returning exactly work's original value or throwing its original error; telemetry errors never replace it. Context carries owned job/run/attempt and optional evidence/parent IDs. `loadDiagnostics(analysisId, runId, cursor)` projects existing audits plus spans. `projectDiagnostics(records, serverNow)` calculates wall time and reused/active state without mutating records.

- [ ] Write deterministic tests proving parallel durations overlap, nested spans are not double-counted, queued retry delays are distinct, reused results do not produce negative/new-call durations, and missing timestamps produce unknown values.
- [ ] Add recorder tests proving bounded writes/flush and original error/value preservation under storage outage. Use lease verification already used by the worker; never extend the lease merely to collect telemetry.
- [ ] Instrument job execution, per-photo download/validation/normalization/upload, private image retrieval/hash verification, reviewer PNG preparation, provider invocation, and final publication boundaries. Do not refactor unrelated pipeline code or change compression/concurrency.
- [ ] Instrument PDF validation/text extraction and accepted private upload. These happen in the authenticated submission request before a worker run exists: retain a bounded request-local timing record, then persist it against the accepted submission/run only after acceptance using a server-only RPC verifying submission ownership. Reject client-provided timings. Failed unaccepted uploads have no report-run timing record; display their existing upload error without creating a fake run.
- [ ] Project text/image/final attempts using their existing audit timestamps and manifest order. Detect reuse from parent run/committed records, not from negative timestamp arithmetic; expose original run provenance.
- [ ] Add integration tests for partial collection, restart, supersession, four-image out-of-order commits, and PDF-only review reuse. Run focused tests and commit.

## Task 4: Private diagnostics and lazy result APIs

Checkpoint allocation: current report/result APIs in checkpoint 1; listing/extraction spans in checkpoint 2; earlier-run browsing/pagination UI support in checkpoint 3. Ownership checks apply from the first checkpoint.

Files to create: `src/features/diagnostics/load-diagnostics.ts`, `src/app/api/analyses/[publicId]/diagnostics/route.ts`, `src/app/api/analyses/[publicId]/diagnostics/results/route.ts`, `src/app/api/listings/[jobId]/diagnostics/route.ts`, `tests/unit/diagnostics/routes.test.ts`, `tests/integration/diagnostics-access.test.ts`.
Files to modify: `src/listings/auto24-service.ts` only if its existing request helper needs a typed diagnostic method.

Interfaces: browser-facing endpoints are exactly those in the design. Resolve `service_job_id` server-side from the authorized analysis input. Results endpoint verifies `executionId` belongs to the requested authorized analysis/run, validates committed result through `ReviewResultSchema`, and returns observations plus provenance. Do not call repository methods that return unrestricted snapshots to the browser.

- [ ] Add failing access tests: disabled flag=404, missing cookie=401, wrong job/run/execution=404, invalid UUID denied, no shared cache, and extraction API keys never serialized.
- [ ] Add fixtures with planted secrets, signed URLs, document text, storage keys, and raw provider errors; prove timing and export projections exclude them. Findings result responses include only their explicitly allowed structured fields.
- [ ] Implement bounded/paginated read projection and lazy results. Return a usable partial snapshot when extraction telemetry fails; distinguish empty from unavailable.
- [ ] Verify completed and historical reports, manual input, capture refresh provenance, and current-run discovery after PDF upload. Run focused API/integration tests and commit.

## Task 5: Drawer, polling, result cards, and export

Checkpoint allocation: report drawer/polling/results in checkpoint 1; dashboard entry and detailed spans in checkpoint 2; earlier-run picker, dedicated PDF comparison, and export in checkpoint 3.

Files to create: `src/features/diagnostics/diagnostics-panel.tsx`, `src/features/diagnostics/use-diagnostics.ts`, `src/features/diagnostics/review-card.tsx`, `src/features/diagnostics/timeline.tsx`, `src/features/diagnostics/export.ts`, `tests/unit/diagnostics/panel.test.tsx`, `tests/unit/diagnostics/polling.test.tsx`, `tests/unit/diagnostics/export.test.ts`.
Files to modify: `src/features/listing/dashboard.tsx`, `src/features/report/report-view.tsx`, `src/app/[locale]/globals.css`, `messages/en.json`, `messages/et.json`; pass the server-resolved feature flag through the existing dashboard/report page boundary.

Interfaces: `DiagnosticsPanel` accepts an authorized listing/report owner and server-resolved enabled flag. The hook owns a single polling loop and request cancellation keyed by owner/run; the panel stays mounted through normal report refreshes. Timeline and cards consume only validated DTOs from Task 1. Export serializes the same timing projection with safe filenames and no private URLs.

- [ ] Add component tests for idle/running/completed/retry/stale/offline/unknown/reused/skipped states, zero findings, result expansion, run switch, and responsive accessibility behavior.
- [ ] Add fake-timer polling tests: three-second interval, one request in flight, closed/hidden pause, reopen refresh, 6/12/30-second backoff, cancellation on owner/run change, and detection of a new PDF run after prior completion.
- [ ] Build the drawer using existing UI primitives and styling; desktop side panel and mobile full-screen sheet. Implement focus trap/return and Escape. Keep thumbnail/result requests lazy.
- [ ] Display safe settings and measured timing, with clear provisional result labels and no in-call percentage/ETA. Show prior/current final results for PDF updates without claiming semantic differences based on unstable IDs.
- [ ] Implement versioned timing-only JSON download; test content exclusions, unknown measurements, pagination availability, and export size bounds. Run focused UI tests and commit.

## Task 6: Verification, documentation, review, and PR

This is a recurring gate at every checkpoint, not a final-only task. Run applicable items for each checkpoint and record their evidence separately. The full integrated workflow is required at checkpoint 3. Features assigned to later checkpoints do not block an earlier checkpoint; access, truthful states, relevant regression tests, clean subagent review, manual E2E, and that checkpoint's PR always do.

Files to modify: `docs/local-development.md`, `README.md`; add sanitized acceptance evidence under `docs/superpowers/checkpoints/`.

- [ ] Document the feature flag, timing boundaries, absent historical measurements, exports, migration order, and rollback by disabling diagnostics. Include known measurement overhead and how to check recorder failure without exposing raw internals in the panel.
- [ ] Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and the Python suite. Run integration tests against a disposable local stack with no unrelated queue.
- [ ] Use a controlled listing with four image results completing out of order and a PDF update. Assert three-image maximum concurrency, commit-before-display, one final assessment for PDF-only upload, and unchanged final barrier/retry behavior.
- [ ] Compare controlled enabled/disabled runs with identical fixed provider delays; check no added provider calls and bounded diagnostic overhead. Report measured overhead rather than inventing a performance improvement.
- [ ] Dispatch independent review under the linked agent policy, including migration/privacy/concurrency review where applicable. Resolve findings and rerun affected checks.
- [ ] Dispatch manual frontend E2E under the linked policy: dashboard capture before report creation; desktop/mobile drawer; English/Estonian; refresh; new PDF run; offline/reconnect; retry; stale lease; unauthorized access; feature disabled; JSON export. Fix issues and repeat affected flows.
- [ ] A real Auto24 smoke run may use a listing the user explicitly chooses for implementation testing. Do not automatically submit ambient browser listing 4353132 or make extra benchmark model calls merely because it was visible during planning.
- [ ] Create a PR with concrete behavior, tests, migration and rollback notes; attach it to the chat. Report acceptance evidence and remaining measurement limits. Stop after the requested implementation scope.

## Planning verification

Coverage: extraction live detail (Tasks 1–2), review/preparation timings (Task 3), private results/access (Task 4), visible progress/export (Task 5), regression and manual proof/PR (Task 6). Checkpoint 1 implementation was subsequently authorized on October 9, 2026. This does not authorize later checkpoints or live listing/model benchmark submissions.
