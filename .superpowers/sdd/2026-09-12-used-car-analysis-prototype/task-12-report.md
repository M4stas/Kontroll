# Task 12 report: seller answers, documents, and additional images

## Status

Implementation and requested verification are complete. Seller answers, maintenance PDFs, additional images, and VIN/registration-plate corrections can be submitted from the existing private report. Accepted groups create one idempotent supplement run and only the affected jobs. Responses and UI state expose file type and processing state, never private storage keys or signed URLs.

No subagents were used, as explicitly requested. Self-review was performed inline.

## Migration map

### Existing readers

- `AnalysesRepository.loadReport(publicId)` reads `analyses.current_run_id`, then run-scoped report rows and `analysis_runs.stage_states`.
- `AnalysesRepository.loadRunContext(analysisId, runId)` reads the selected run, original analysis input, and stage state.
- `JobsRepository.lease()` and the worker read `analysis_jobs` by queue/lease state.
- Private upload reads are analysis-scoped through `AnalysisUploads.createSignedReadUrl()`.

### Existing writers

- `create_analysis(...)` atomically creates an analysis, initial input, initial run, selects it as `current_run_id`, and queues `capture_listing`.
- Stage handlers write run state and run-scoped evidence/report records.
- `JobsRepository.enqueue()` writes one idempotent stage job.
- `AnalysisUploads.upload()` writes one private, random, analysis-scoped object after byte-level MIME verification.

### Existing data shape

- `submissions` already had analysis/run binding, kind/provider, text or private storage key, MIME type, and a unique text idempotency key.
- `analysis_runs` already supported `trigger = 'supplement'` but had no submission-group idempotency key.
- `analyses.current_run_id` is the stable indirection that lets the same public report URL resolve a newer run.
- `analysis_jobs` already enforced one job per analysis/run/stage.

### Forward path

Migration `202609200001_atomic_supplement_submissions.sql` is expand-only:

1. Add nullable `analysis_runs.submission_idempotency_key uuid`.
2. Add a partial unique index on `(analysis_id, submission_idempotency_key)` for non-null values.
3. Add service-role-only `accept_analysis_submission_group(uuid, uuid, jsonb, text[])`.
4. The function locks the analysis, returns the existing supplement run on retry, validates the complete group, inherits unaffected stage state, creates one supplement run, inserts all submission rows, inserts only affected jobs, and changes `current_run_id` in one database transaction.
5. Existing readers and writers remain valid because the new field is nullable and no existing column, constraint, or function signature changes.

The client-provided UUID identifies the whole accepted group. Per-row submission idempotency keys are derived from analysis ID, group UUID, and item ordinal. Job keys remain analysis/run/stage scoped.

### Rollback

A compatibility rollback removes only Task 12 additions:

```sql
drop function if exists public.accept_analysis_submission_group(uuid, uuid, jsonb, text[]);
drop index if exists public.analysis_runs_submission_idempotency_idx;
alter table public.analysis_runs drop column if exists submission_idempotency_key;
```

No existing table or pre-Task-12 column is dropped. Existing analyses, initial runs, report data, submissions, and jobs are preserved. Supplement rows created before rollback remain valid under the original schema; only group-level retry recognition is removed.

### Mixed-version and idempotency reasoning

- Old code ignores the nullable run field and continues using existing repository methods.
- New code calls the additive RPC through the service-role client only.
- Anonymous and authenticated roles have explicit execute revocation; only `service_role` is granted execution.
- Concurrent requests for the same analysis serialize on the analysis row. A retry with the same UUID returns the first run and jobs instead of writing another group.
- A duplicate request can upload temporary duplicate objects before discovering the accepted group. The route removes those newly uploaded objects and returns the original run.

### Preservation and partial-failure proof

- The real integration test proves the initial run remains present after a supplement run is accepted.
- The real integration test proves a duplicate UUID leaves exactly one supplement run, two requested submission rows, one `current_run_id`, and only the three affected jobs.
- The invalid-group integration test proves PostgreSQL rolls back the run, submissions, jobs, and `current_run_id` together.
- Private objects are uploaded only after access verification. If any upload or database persistence step fails, every object uploaded by that request is passed to analysis-scoped storage cleanup.
- Storage cleanup is deliberately best-effort: if the storage API itself is unavailable, the API still returns a generic failure (or the already accepted idempotent result), and a random analysis-scoped orphan may remain for operator reconciliation. No user-controlled path or original filename is used.

## Security and privacy

- Analysis capability access is verified before `request.formData()`, file reads, internal analysis lookup, upload, or run creation.
- Seller and buyer material remains unverified; the UI states this directly and persisted source semantics are not promoted to official verification.
- Request limits are 10,000 characters per answer and eight files.
- File bytes are rechecked against JPEG, PNG, WebP, or PDF MIME declarations.
- Image uploads are auto-oriented with Sharp and re-encoded without EXIF/metadata before private persistence.
- Storage keys use random UUID filenames below the authorized analysis UUID prefix.
- Cleanup validates every key against the same analysis prefix.
- API/UI output contains run ID, affected stages, MIME-derived file type, and processing state only. It contains no storage key, signed URL, or original filename.

## TDD evidence

### RED

- The brief's exact initial unit test failed because `@/features/supplements/add-submission` did not exist.
- Route security/privacy tests failed because the submissions route did not exist.
- EXIF regression failed with stored dimensions `2x3` instead of the correctly oriented `3x2`.
- Cleanup regression failed because `AnalysisUploads.remove()` did not exist.
- UI tests failed because `SupplementForm` and the post-report action did not exist.
- The integration test initially had no acceptance RPC to call.

### GREEN

- Added the service and affected-stage union, then observed the focused service suite pass.
- Added metadata-stripping upload and scoped removal, then observed all upload tests pass.
- Added access-first multipart route, private response shape, and cleanup behavior, then observed route tests pass.
- Added the expand-only RPC and reset local Supabase from scratch; atomic, rollback, idempotency, and permissions tests passed against real PostgreSQL/Supabase.
- Added the report-sheet supplement UI and localization, then observed component/report tests pass.
- Added the real report E2E flow and observed the changed verdict at the same URL.

## Verification results

- `npm run test -- tests/unit/supplements` — PASS, 3 files, 13/13 tests.
- `npm run test:integration -- tests/integration/submissions.test.ts` — PASS, 5 files, 29/29 tests. The package script intentionally includes the full integration directory.
- `npm run test:e2e -- tests/e2e/analysis.spec.ts` with local Supabase environment, cookie secret, and worker ID — PASS, Chromium 1/1 in 8.5 seconds.
- `npm run test` — PASS, 30 files, 202/202 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS with no warnings.
- `git diff --check` — PASS.
- Clean Supabase reset applied all migrations through `202609200001_atomic_supplement_submissions.sql` successfully.

One integration verification attempt encountered a pre-existing 10-second setup timeout while `npx supabase status -o env` resolved the CLI. No assertion failed. After warming that local CLI command, the exact integration command completed with 29/29 tests. It was not repeatedly rerun.

## Files changed

### Production

- `src/features/supplements/add-submission.ts`
- `src/features/supplements/supplement-form.tsx`
- `src/app/api/analyses/[publicId]/submissions/route.ts`
- `src/features/report/report-view.tsx`
- `src/server/storage/uploads.ts`
- `src/server/repositories/analyses.ts`
- `src/server/repositories/jobs.ts`
- `supabase/migrations/202609200001_atomic_supplement_submissions.sql`
- `messages/en.json`
- `messages/et.json`

`src/analysis/affected-stages.ts` already contained the exact required stage mapping from prior completed work, so it did not need a production edit.

### Tests

- `tests/unit/supplements/add-submission.test.ts`
- `tests/unit/supplements/route.test.ts`
- `tests/unit/supplements/supplement-form.test.tsx`
- `tests/unit/storage/uploads.test.ts`
- `tests/unit/report/report-view.test.tsx`
- `tests/integration/submissions.test.ts`
- `tests/e2e/analysis.spec.ts`

### Report

- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-12-report.md`

Generated `next-env.d.ts` drift from the Next development server was restored before commit. Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` were preserved and excluded.

## Self-review and concerns

Self-review checked the brief line by line, the complete diff, migration permissions, idempotent retry behavior, mixed-version compatibility, private response shape, access ordering, scoped cleanup, EXIF orientation, localization, and preservation of unrelated files.

One migration defect found during self-review counted JSON `storage_key: null` fields as files. It was fixed to count only non-empty storage keys, followed by a clean database reset and passing final integration run.

No critical or important code issue remains. Operational concerns:

- Storage deletion is best-effort. A storage outage after upload and before/after database acceptance can leave a random analysis-scoped orphan; the database remains atomic and retry-safe.
- The E2E development server emits existing Next.js middleware-deprecation and color-environment warnings. They do not affect Task 12 behavior or test results.

## Accepted review remediation

The corrective implementation is additive and leaves `202609200001` unchanged.

- `202609200002_cumulative_supplement_runs.sql` adds parent-run lineage, submission metadata/source provenance, cumulative stage invalidation, missing-prerequisite queuing, and obsolete-job supersession under the existing analysis row lock.
- `202609200003_repair_cumulative_supplement_function.sql` safely repairs local databases that recorded an earlier draft of `002`; clean installations receive the already-correct `002` body and the repair is idempotent.
- Rollback instructions/artifacts are under `supabase/rollbacks/`. They preserve report, submission, and upload rows; application code must be rolled back before removing the additive lineage columns.
- Run contexts now load cumulative supplements. Identity corrections affect normalization; all supplied kinds create explicitly unverified evidence; seller/buyer text and document/screenshot context reach enrichment; images use analysis-scoped short-lived signed private reads.
- Report readers compose current and ancestor runs, preserving facts, source snapshots, evidence, finding/evidence relationships, findings, and actions without overwriting audit history.
- Ambiguous acceptance errors reconcile by analysis and idempotency key. Referenced uploads are preserved, proven-unreferenced uploads are removed, and indeterminate reconciliation preserves files.
- Multipart parsing now requires a valid aggregate `Content-Length` below the eight-file ceiling plus bounded field/overhead allowance.
- The post-success form clears both React file state and the native file input while retaining its processing summary; the disclosure exposes a persistent label and live expanded state.
- The E2E no longer updates `analyses.verdict` directly. It submits a real generated PNG and seller answer through the browser, executes queued stages through the production worker path, observes the worker-published verdict at the same URL, and expands preserved evidence from the previous run.

Final corrective verification:

- `npm run test` — PASS, 30 files, 217/217 tests.
- `npm run test:integration -- tests/integration/submissions.test.ts` — PASS, 5 files, 37/37 tests against local Supabase.
- `npm run test:e2e -- tests/e2e/analysis.spec.ts` — PASS, Chromium 1/1 with real upload and worker processing.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `git diff --check` — PASS.
- Local migration list — `202609200002` and `202609200003` both applied after `202609200001`.

## Fix round 2 completion

- Preserved Avicenna's uncommitted partial changes and completed them in the main Codex thread.
- Added submission-run ownership to cumulative supplement evidence and carried enrichment evidence IDs into the assembled report snapshot.
- Remapped inherited findings/actions into the current run while retaining valid cross-lineage evidence links; stale ancestor findings no longer union into the current snapshot.
- Added production HMAC image capabilities and Supabase-origin enforcement with acceptance, forged-signature, expiry, wrong-origin, and cross-analysis coverage.
- Made leasing single-active-stage and priority/DAG ordered per run, with concurrent transition tests through baseline, research, enrichment, and assembly.
- Preserved uploads after ambiguous persistence attempts while cleaning failures proven to occur before persistence.
- Uninspected documents remain explicitly unverified and do not satisfy image/maintenance checks.
- Replaced destructive/comment-only rollback guidance with executable, data-preserving rollback SQL. All rollback files executed in a real PostgreSQL transaction ending in `ROLLBACK`.
- Applied migration `202609200004` forward to the current local database without a destructive reset.

Final round-2 verification:

- `npm run test` — PASS, 30 files, 224/224 tests.
- `npm run test:integration` — PASS, 5 files, 40/40 tests against local Supabase.
- `npm run test:e2e -- tests/e2e/analysis.spec.ts` — PASS, Chromium 1/1 with image-only upload and worker processing.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `git diff --check` — PASS.
- Local migration list — `202609200004` applied after `202609200003`.

## Fix round 4: Sagan findings

This round continued the interrupted implementers' uncommitted changes. No subagents were used, as requested. The review was done inline. Local data was not reset, and tests delete only analyses or cache entries they created.

### Findings and fixes

1. **Safe local E2E.** The browser test now rejects non-loopback Supabase URLs and compares the configured endpoint with the running local instance. It no longer deletes the global `analyses` table. It leases only its own analysis through `JobsRepository.leaseForAnalysis`, which calls the database lease RPC and therefore enforces the same stage prerequisites and exclusive lease rules as the worker. It removes its own uploaded object and analysis row, including when the test fails. A seed failure also deletes its own analysis.
2. **Exhausted optional stages.** `fail_analysis_job` records exhausted `research` and `enrich` as terminal `unavailable` stage states with explicit warnings. The worker queues `enrich` after exhausted research and final assembly after exhausted enrichment; the report assembler treats terminal unavailable research and enrichment as sufficient to publish a deterministic final report. Integration tests drive four transient attempts through each path.
3. **Committed response loss.** `loadReport` selects facts, evidence, sources, findings, and actions from lineage only when their producer's stage has a terminal state. Empty terminal normalization and baseline evidence sets remain authoritative. Tests commit artifacts without a terminal producer state and confirm the public report excludes them.
4. **Artifact ownership and empty-set synchronization.** SQL triggers reject cross-analysis and nonancestor artifact references, including direct service-role writes. Checked findings/actions RPC wrappers validate replacement scope before stale-set deletion. Repositories call scoped save RPCs even for empty arrays, allowing stale producer rows to clear. The focused schema test covers cross-analysis references and empty replacements.
5. **Image capability.** A real local image is uploaded privately, hydrated into a repository-issued signed capability, verified, downloaded through its signed URL, and passed through the production insight provider. Only the external OpenAI response call is mocked; the test checks that its request includes `input_image` with the signed storage URL. The browser E2E exercises an actual image submission and subsequent worker path.
6. **Fair leasing.** Global and scoped lease SQL order eligible work by run creation time, then give the initial progressive assembly priority within its run. The predecessor and one-active-stage conditions remain in force. Integration tests cover older research ahead of a newer initial assembly, and an initial partial report before optional work in the same run.

### Migration and rollback

- Existing migrations `202609230001` and `202609230002` were already applied in the local database. Applied pending `202609230003_scoped_analysis_leasing.sql` with `supabase migration up --local`; no reset or broad deletion occurred.
- Added `supabase/rollbacks/202609230003_scoped_analysis_leasing.sql`. It restores the global lease body from `001` before dropping the scoped helper. Rollback order is `003`, `002`, `001`, after rolling application code back.
- Ran all three rollback files against local PostgreSQL in one transaction with `ON_ERROR_STOP=1`. Output reached `ROLLBACK` with exit 0. The transaction did not persist the rollback or alter test data.

### RED/GREEN evidence

- **RED (observed):** Temporarily removed the new repository lease method while preserving the E2E and integration callers. `npm run typecheck` exited 2 with TS2339 at `tests/e2e/analysis.spec.ts:314` and `tests/integration/job-leasing.test.ts:79`. Restored the method immediately.
- **GREEN (observed):** `npm run typecheck` then exited 0. The integration test leases only the requested analysis while another queued job remains untouched; the browser E2E passes through the same scoped RPC.
- The other five findings were inherited with test and implementation edits already present. Their pre-fix RED command output was not available after the two interruptions; the relevant failing conditions are evident in the pre-round diff (global E2E deletion, direct job row update, absent terminal unavailable state, artifact fallback, and lease order). This report does not claim an unobserved test failure.

### Verification

- `npm run test` — 31 files, 232/232 passed.
- `npm run test:integration` — 6 files, 52/52 passed against local Supabase, including the signed image download proof.
- `npm run test:e2e -- tests/e2e/analysis.spec.ts` — Chromium 1/1 passed after the final E2E cleanup changes.
- `npm run typecheck` — passed after restoring the lease method; `npm run lint` and `git diff --check` — passed.
- PostgreSQL rollback transaction — `BEGIN`, three rollback scripts, `ROLLBACK`, exit 0.

The test substitutes the external OpenAI response; it proves the production provider constructs the signed image request, not that OpenAI fetched the image. The local HTTP exception for signed images is restricted to loopback origins; production storage still requires HTTPS.

Committed repair files as `70994f3` (`fix(evidence): close Task 12 review gaps`) and opened private-repository PR https://github.com/M4stas/kontroll/pull/1. This report is under the repository's ignored `.superpowers/` path and remains available locally. Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` were left untouched. Generated `next-env.d.ts` drift was restored before the commit.

### Final visual follow-up

Manual inspection of the E2E's initial and completed 390px report screenshots found the uploaded PNG still labeled “Processing” after the report header showed “Analysis complete.” The form held the submission response's processing state without reconciling it with the refreshed report. This was fixed in the form at the narrow display layer: it uses the report status and update timestamp from before the submission to show “Processed” and an up-to-date message only when the newer report is complete. It also labels a failed newer report as failed. English and Estonian messages were updated.

- **RED (observed):** the new component regression test failed with `Expected: PNGProcessed; Received: PNGProcessing` while the form received a newer completed report.
- **GREEN (observed):** focused UI tests passed 18/18; full unit tests passed 233/233; integration passed 52/52; the browser E2E passed 1/1 with explicit assertions for “Processed” and the updated success message. Typecheck, lint, and diff checks passed.
- A second manual screenshot review confirmed the completed report and PNG row agree. Temporary screenshot calls were removed from the test; only the behavior assertions remain. `next-env.d.ts` was restored after the final browser run.

Committed the UI follow-up as `34f6a0d` (`fix(evidence): reconcile supplement processing state`) and pushed it to PR https://github.com/M4stas/kontroll/pull/1. Final committed HEAD is `34f6a0d`.

## Fix round 5: integration lease isolation

The progressive worker fixtures and the non-global leasing checks now call `JobsRepository.leaseForAnalysis` with the analysis created by each test. The same correction covers the dependent and delayed-job checks in `job-leasing.test.ts`. Global calls remain only where the test checks global scheduling: concurrent workers, initial partial assembly, and older-work fairness. Before those calls, tests reject any queued or leased job outside their fixtures. Their fixture runs are dated ahead of normally created runs so a newly queued local job cannot take priority between the guard and the lease. No production code, migration, or unrelated analysis was changed or deleted.

Added a regression that creates an older queued analysis, processes one stage for a newer fixture, and verifies the older job remains queued with zero attempts. With the worker helper temporarily restored to its original global lease, the focused regression failed because it processed the older analysis ID. Restoring the scoped call made the regression pass.

Verification after the final edits:

- `npx vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts tests/integration/job-leasing.test.ts` — PASS, 2 files, 16/16 tests.
- `npm run test:integration` — PASS, 6 files, 53/53 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `git diff --check` — PASS.

Unit and browser E2E tests were not rerun because the diff changes only integration tests. The global scheduling tests intentionally fail before leasing when the shared local database contains foreign queued or leased jobs. The guard and fixture priority cover jobs with ordinary creation times; simultaneous external writes using earlier backdated run times would still require a dedicated test database for strict isolation. The ignored report and untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` remain outside the commit.

Committed the two test files as `45213d2` (`test(integration): isolate analysis job leases`).
