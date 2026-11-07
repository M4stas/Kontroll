# PDF Processing Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a taustakontroll PDF upload, the report's Live diagnostics drawer shows how long PDF validation, text extraction and upload took, and shows the previous and current final assessments side by side.

**Architecture:** The submission request measures each PDF's phases in memory. Only after `accept_analysis_submission_group` creates a new run does the handler persist those spans, through a new service-role RPC that checks the run belongs to the analysis and carries the request's idempotency key. The diagnostics repository reads the spans and the final execution of the run named by `review_reuse_run_id`, and the drawer renders both. Text and photo reuse labels already exist from the live review panel and stay as they are.

**Tech Stack:** Next.js 16 + React, TypeScript, zod, Supabase/Postgres, vitest, pnpm. No new dependency.

**Spec:** [Live diagnostics design](../specs/2026-10-09-live-diagnostics-design.md). Scope comes from [roadmap checkpoint 16](../roadmap.md#checkpoint-16-pdf-processing-and-reassessment). This plan replaces the checkpoint 3 portions of the [live diagnostics plan](2026-10-09-live-diagnostics.md) for checkpoint 14. The earlier-run picker and the timing export stay in the deferred backlog.

## Global Constraints

- Follow the [agent policy](../../agent-policy.md) for every dispatch. The migration in Task 1 gets the final migration, privacy and concurrency review the policy names.
- Recording runs only when `isLiveDiagnosticsEnabled()` (`src/config/application.ts`) is true. Disabled means no spans and no extra RPC call.
- Every diagnostics read keeps the existing access cookie check and `Cache-Control: private, no-store`.
- No document text, file names, storage keys, signed URLs, content hashes or raw error messages in spans or diagnostics payloads.
- A rejected upload (any 4xx or 5xx from the submissions handler) writes no span and creates no run.
- A replayed request (`created: false`) writes no span. The first accepted request owns the run's spans.
- Timing persistence never changes the submission response. It waits at most **100 ms** after acceptance, then gives up.
- At most **24** spans per run (8 files, 3 phases each).
- The migration is additive, with a matching file in `supabase/rollbacks/`.
- Previous and current final results are shown as written. No added, changed or removed labels.
- Overhead gate: five alternating enabled/disabled pairs, at most **500 ms** added wall time per pair, identical provider-call counts and publication outcome. Fake reviewer command only; no live listings and no model calls.
- Commands: `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Never npm.
- Read the relevant guide in `node_modules/next/dist/docs/` before touching route handlers or components.
- No AI attribution lines in commits. No em dashes in docs or commits. Ask before pushing.

## Review Focus

1. Two browser tabs send the same idempotency key at once. Only the request that gets `created: true` writes spans, and the run never holds duplicates. Test in Task 2 (`replayed submission writes no timings`) and Task 1 (`rejects a second batch for the same run`).
2. A PDF that fails text extraction (locked or scanned). The response stays the existing 400 with `invalid_pdf`, and no RPC call is made. Test in Task 2 (`rejected PDF writes no timings`).
3. The timing RPC is slow or down. The handler still returns 202 within the 100 ms budget plus normal work, and the drawer shows PDF timings as unavailable. Tests in Task 2 (`slow timing write does not delay acceptance past budget`) and Task 3 (`timing read failure marks submission timings unavailable`).
4. A seller answer or image upload with no PDF. No PDF section appears, and no previous-final comparison appears unless the run is a PDF reuse run. Test in Task 3 (`non-PDF run has no submission timings or previous final`).
5. A second PDF uploaded while the first reassessment is still running. The drawer follows the new current run, and its previous final is the run named by the new run's `review_reuse_run_id`, never a stale one. Test in Task 3 (`previous final follows review_reuse_run_id of the current run`).

---

## Checkpoint 14: PDF processing and reassessment

### Before starting

- [ ] Create a worktree from current `main` with the worktree skill. Record the baseline commit in the PR.
- [ ] Start a disposable local Supabase stack on its own ports, as the [photo timing checkpoint](../archive/photo-preparation-timings/checkpoint.md) did. Never use the user's running stack or queue.

### What you will see

Upload a taustakontroll PDF on a finished report and open Live diagnostics. A "PDF processing" section lists each accepted PDF with its validation, text extraction and upload times. The text and photo cards say "Reused" with their original completion times. Below them, "Final assessment" shows the previous final result and the new one side by side, each with its own completion time.

### How to check

1. Set `LIVE_DIAGNOSTICS_ENABLED=true` in `.env.local`, start the app and the worker as in [local development](../../local-development.md), and open a finished report.
2. Upload a text-based taustakontroll PDF from the evidence row, then open Live diagnostics. "PDF processing" shows three times for the file.
3. Wait for the review to finish. Exactly one final assessment card is new. The text and photo cards say "Reused" and keep their original times.
4. Under "Final assessment", the previous and current results both show, each with its time.
5. Upload a locked PDF. The existing error shows, and the drawer still shows the earlier run with no new PDF entry.
6. Send a seller answer instead of a PDF. The drawer shows no "PDF processing" section and no previous final.
7. Repeat in Estonian and at 390px.
8. Read the overhead table in the checkpoint report. Every pair is at most 500 ms.

### Task 1: Submission timing storage

**Files:**
- Create: `supabase/migrations/202610210001_submission_timings.sql`
- Create: `supabase/rollbacks/202610210001_submission_timings.sql`
- Modify: `src/diagnostics/contracts.ts`
- Test: `tests/integration/submission-timings.test.ts`, `tests/unit/diagnostics/contracts.test.ts`

**Interfaces:**
- Produces table `public.diagnostic_submission_spans(id uuid pk, analysis_id uuid fk cascade, run_id uuid fk cascade, file_index integer 0..7, phase text, state text, started_at timestamptz, completed_at timestamptz, duration_ms double precision)`. RLS on, no browser grants, `select` for `service_role` only, like `diagnostic_photo_spans`.
- Produces RPC `public.record_submission_timing_spans(p_analysis_id uuid, p_run_id uuid, p_idempotency_key uuid, p_spans jsonb) returns void`, `security definer`, `set search_path=''`, `service_role` only.
- Produces in `contracts.ts`:
  - `SubmissionPhaseSchema = z.enum(["pdf_validation", "pdf_text_extraction", "pdf_upload"])`
  - `SubmissionSpanSchema = { id, fileIndex: 0..7, phase, state: "complete" | "failed", startedAt, completedAt, durationMs }`, strict
  - `SubmissionTimingsSchema = { availability: "available" | "unavailable" | "not_recorded", spans: SubmissionSpan[] max 24 }`, strict
  - `DiagnosticsSnapshotSchema` gains optional `submission: SubmissionTimingsSchema` and `previousFinal: { runId, executionId, completedAt } | null` (optional)
  - Exported types `SubmissionPhase`, `SubmissionSpan`, `SubmissionTimings`

- [ ] **Step 1: Write the failing integration tests** against the disposable stack:
  - `records spans for a run created by the same idempotency key`: accept a PDF-only group, call the RPC with its key and three spans, read three rows back.
  - `rejects a key that does not match the run`: raises, no rows.
  - `rejects a run of another analysis`: raises, no rows.
  - `rejects a second batch for the same run`: second call raises, row count stays three.
  - `rejects more than 24 spans, unknown fields, unknown phases, negative durations, completedAt before startedAt`: each raises.
  - `browser roles cannot read or write`: `anon` and `authenticated` get permission errors on the table and the RPC.
  - `analysis deletion removes spans`: cascade.
- [ ] **Step 2: Run** `pnpm test:integration tests/integration/submission-timings.test.ts`. Expected: FAIL, the table does not exist.
- [ ] **Step 3: Write the migration and its rollback.** The RPC requires `auth.role() = 'service_role'`, locks the run row, checks `analysis_runs.analysis_id = p_analysis_id and submission_idempotency_key = p_idempotency_key`, rejects any existing rows for the run, validates every element as `diagnostic_photo_spans`' RPC does (key allowlist, array length 1..24, `octet_length <= 16384`), and inserts. The run does not need to be current: a PDF reuse run can be superseded before the write lands.
- [ ] **Step 4: Run** the integration tests again. Expected: PASS.
- [ ] **Step 5: Write failing contract tests** in `contracts.test.ts`: a valid `SubmissionSpan` parses; `fileIndex: 8`, `state: "running"`, extra keys and negative `durationMs` fail; a snapshot without `submission` and `previousFinal` still parses.
- [ ] **Step 6: Add the schemas.** Run `pnpm test tests/unit/diagnostics/contracts.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: store PDF processing timings per accepted submission`.

### Task 2: Measure PDF phases in the submission request

**Files:**
- Create: `src/diagnostics/submission-timings.ts`
- Modify: `src/server/storage/uploads.ts`
- Modify: `src/app/api/analyses/[publicId]/submissions/handler.ts`
- Modify: `src/server/repositories/jobs.ts` (one method for the RPC)
- Test: `tests/unit/diagnostics/submission-timings.test.ts`, `tests/unit/supplements/route.test.ts`

**Interfaces:**
- Consumes: `SubmissionSpan`, `SubmissionPhase` from Task 1; the RPC from Task 1.
- Produces in `submission-timings.ts`:
  - `class SubmissionTimingRecorder { constructor(options: { enabled: boolean; monotonic?: () => number; now?: () => Date }); spans(): SubmissionSpan[] }`. In memory only, capped at 24, never does I/O.
  - `runSubmissionTimings<T>(recorder, operation: () => Promise<T>): Promise<T>`
  - `withSubmissionFile<T>(fileIndex: number, operation: () => Promise<T>): Promise<T>`
  - `measureSubmissionPhase<T>(phase: SubmissionPhase, operation: () => Promise<T>): Promise<T>`. Outside a scope or a file it runs `operation` unchanged. It returns the original value and rethrows the original error.
  - `persistSubmissionTimings(write: (spans: SubmissionSpan[], signal: AbortSignal) => Promise<void>, spans: SubmissionSpan[], budgetMs = 100): Promise<void>`. Never throws, aborts the write after `budgetMs`.
- Produces in `jobs.ts`: `recordSubmissionTimings(input: { analysisId: string; runId: string; idempotencyKey: string; spans: SubmissionSpan[] }, signal: AbortSignal): Promise<void>`
- `SubmissionHandlerDependencies` gains `diagnosticsEnabled: boolean` and `recordSubmissionTimings` with the `jobs.ts` signature.

- [ ] **Step 1: Write failing recorder tests** with a fake clock:
  - `measures a phase and returns its value`: one `complete` span, `durationMs` from the fake clock.
  - `keeps the original error`: the phase throws `PdfValidationError`; the same instance is rethrown and the span is `failed`.
  - `does nothing outside a scope`: no spans, value unchanged.
  - `does nothing when disabled`.
  - `stops at 24 spans`.
  - `persist gives up after the budget`: a `write` that never resolves; `persistSubmissionTimings` resolves after 100 ms of fake time and the signal is aborted.
  - `persist swallows write errors`.
- [ ] **Step 2: Run** `pnpm test tests/unit/diagnostics/submission-timings.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `submission-timings.ts`** with `AsyncLocalStorage`, following `photo-timings.ts`.
- [ ] **Step 4: Run** the recorder tests. Expected: PASS.
- [ ] **Step 5: Wrap the PDF phases in `AnalysisUploads.upload`.** When `file.type === "application/pdf"`: the size, MIME and `fileTypeFromBuffer` checks run in `measureSubmissionPhase("pdf_validation", ...)`, `extractPdfText` in `"pdf_text_extraction"`, and the storage upload in `"pdf_upload"`. Image paths keep their existing `measurePhotoPhase` calls.
- [ ] **Step 6: Write failing handler tests** in `route.test.ts`, with fake dependencies:
  - `accepted PDF writes its timings once`: one `recordSubmissionTimings` call with the accepted `runId`, the request's idempotency key and three spans with `fileIndex: 0`.
  - `two PDFs get file indexes 0 and 1`.
  - `replayed submission writes no timings`: `addSubmission` returns `created: false`.
  - `rejected PDF writes no timings`: `uploads.upload` throws `PdfValidationError`; response 400 with `invalid_pdf`; no call.
  - `disabled diagnostics writes no timings`.
  - `timing write failure keeps the 202`.
  - `slow timing write does not delay acceptance past budget`: a write that never resolves; the handler resolves with 202.
  - `seller answer only writes no timings`.
- [ ] **Step 7: Run** `pnpm test tests/unit/supplements/route.test.ts`. Expected: FAIL.
- [ ] **Step 8: Wire the handler.** Wrap the upload loop in `runSubmissionTimings` with a recorder built from `diagnosticsEnabled`, and each file in `withSubmissionFile(index, ...)` (index over `files` only, not screenshots). After `addSubmission` returns `created: true` and the recorder has spans, `await persistSubmissionTimings(...)` before returning 202. `defaultDependencies` passes `isLiveDiagnosticsEnabled()` and `jobs.recordSubmissionTimings`.
- [ ] **Step 9: Run** the handler and recorder tests. Expected: PASS. Run `pnpm test:integration tests/integration/submissions.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 10: Commit** `feat: time PDF validation, text extraction and upload`.

### Task 3: Read PDF timings and the previous final

**Files:**
- Modify: `src/server/repositories/diagnostics.ts`
- Modify: `src/diagnostics/project.ts`
- Test: `tests/unit/diagnostics/project.test.ts`, `tests/unit/diagnostics/results.test.ts`, `tests/integration/diagnostics-access.test.ts`

**Interfaces:**
- Consumes: `SubmissionTimings`, `previousFinal` shape from Task 1.
- `DiagnosticRecords` gains `submissionSpans?: Row[]`, `submissionUnavailable?: boolean`, `previousFinal?: Row | null`.
- `projectDiagnostics` sets `submission` only when the run has a PDF submission or spans, and `previousFinal` only when the run has `review_reuse_run_id`.
- `DiagnosticsRepository.result(publicId, runId, executionId)` also accepts the current run's `review_reuse_run_id` as `runId`, only for that run's `final` execution.

- [ ] **Step 1: Write failing projection tests:**
  - `projects PDF spans in file and phase order`.
  - `drops malformed spans and marks timings unavailable when none parse`.
  - `timing read failure marks submission timings unavailable`.
  - `PDF run without spans shows not_recorded`: covers runs from before this checkpoint.
  - `non-PDF run has no submission timings or previous final`.
  - `projects previous final from the reuse run`: `previousFinal` has the reuse run's id, its final execution id and `completed_at`.
- [ ] **Step 2: Run** `pnpm test tests/unit/diagnostics/project.test.ts`. Expected: FAIL.
- [ ] **Step 3: Extend `projectDiagnostics`.** Reject rows that fail `SubmissionSpanSchema`, like photo spans. Never project rows from another run.
- [ ] **Step 4: Extend `DiagnosticsRepository.load`.** Add `review_reuse_run_id` to the run select. In the existing `Promise.all`, read `diagnostic_submission_spans` for the run (limit 25) and `submissions` for the run's PDF documents (kind and MIME only, no storage keys or text). When `review_reuse_run_id` is set, read that run's `final` row from `review_executions` (`id,run_id,completed_at,result_hash`).
- [ ] **Step 5: Run** the projection tests. Expected: PASS.
- [ ] **Step 6: Write failing result tests** in `results.test.ts`:
  - `returns the previous final result for the reuse run`.
  - `refuses a non-final execution of the reuse run`: 404.
  - `refuses a run that is neither current nor its reuse parent`: 404.
  - `previous final follows review_reuse_run_id of the current run`: after a second PDF run, the first run's final is refused and the second run's parent is returned.
- [ ] **Step 7: Implement the `result` change.** Keep `ReviewResultSchema` parsing and `sanitizeReviewAuditValue` exactly as they are.
- [ ] **Step 8: Add access cases** to `tests/integration/diagnostics-access.test.ts`: missing cookie 401 and flag off 404 for the previous-final result URL. Plant a storage key, a file name and PDF text in fixtures, and assert none appear in the snapshot JSON.
- [ ] **Step 9: Run** `pnpm test tests/unit/diagnostics` and `pnpm test:integration tests/integration/diagnostics-access.test.ts`. Expected: PASS.
- [ ] **Step 10: Commit** `feat: serve PDF timings and the previous final in diagnostics`.

### Task 4: PDF section and final comparison in the drawer

**Files:**
- Create: `src/features/diagnostics/submission-timings.tsx`
- Create: `src/features/diagnostics/final-comparison.tsx`
- Modify: `src/features/diagnostics/diagnostics-panel.tsx`
- Modify: `messages/en.json`, `messages/et.json` (`Diagnostics` namespace)
- Test: `tests/unit/diagnostics/submission-timings.test.tsx`, `tests/unit/diagnostics/final-comparison.test.tsx`, `tests/unit/diagnostics/panel.test.tsx`

**Interfaces:**
- Consumes: snapshot fields from Task 1 and the result URL from Task 3.
- `SubmissionTimings({ timings }: { timings: SubmissionTimings })`, styled like `capture-timings.tsx`.
- `FinalComparison({ publicId, previous, current, cache })`: `previous` is `snapshot.previousFinal`, `current` is the current run's `final` review. Each column loads its result lazily through the existing results request and shares the panel's `cache`.

- [ ] **Step 1: Write failing component tests:**
  - `lists each PDF with three phase times`: "PDF 1" with validation, text extraction and upload times.
  - `shows a failed phase in the attention color`.
  - `shows not recorded and unavailable states`.
  - `comparison shows previous and current results as written`: two columns, their observations in stored order, each with its completion time, no added, changed or removed labels.
  - `comparison waits for the current final`: while the current final is not `complete`, its column says it is still running and the previous column still shows.
  - `panel hides both sections for a non-PDF run`.
- [ ] **Step 2: Run** `pnpm test tests/unit/diagnostics`. Expected: FAIL.
- [ ] **Step 3: Add the strings** to both message files: `pdfProcessing`, `pdfFile` (with `{number}`), `pdfPhase.pdf_validation`, `pdfPhase.pdf_text_extraction`, `pdfPhase.pdf_upload`, `finalComparison`, `previousFinal`, `currentFinal`, `finalRunning`. Ask the user to confirm the Estonian strings in the PR.
- [ ] **Step 4: Build both components** and render them in `diagnostics-panel.tsx` after `CaptureTimings` and after the review cards. At 390px the two columns stack.
- [ ] **Step 5: Run** `pnpm test tests/unit/diagnostics`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: show PDF processing and the previous final in diagnostics`.

### Task 5: Verification, overhead and PR

**Files:**
- Create: `docs/superpowers/checkpoints/2026-10-21-pdf-diagnostics.md` and its raw overhead JSON
- Modify: `docs/live-diagnostics.md` (diagnostics section)

- [ ] **Step 1: Run** `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck` and `pnpm build`. Expected: all pass. Record the counts.
- [ ] **Step 2: Run the overhead gate** on the disposable stack: five alternating pairs, each uploading one generated text PDF to a finished report and waiting for publication, with a fake reviewer command that waits 30 ms. Record each pair's enabled, disabled and added time, the provider calls (one final call per run) and the publication outcome. Every pair adds at most 500 ms.
- [ ] **Step 3: Write the checkpoint report** with the gate results, the overhead table and the raw JSON. Add the submission timings and their rollback to `docs/live-diagnostics.md`.
- [ ] **Step 4: Follow the [review policy](../../agent-policy.md#cross-provider-routing)** with migration, privacy and concurrency as review concerns. Fix findings and rerun affected checks.
- [ ] **Step 5: Follow [checkpoint validation](../../../AGENTS.md#checking-a-checkpoint)** for "How to check" steps 1 to 7 on the disposable stack with generated PDFs. Fix issues and repeat affected steps.
- [ ] **Step 6: Commit,** then ask the user before pushing. Open the PR against `main` with the `pr` skill. Update this checkpoint's roadmap row to "PR open; user acceptance pending". Stop.
