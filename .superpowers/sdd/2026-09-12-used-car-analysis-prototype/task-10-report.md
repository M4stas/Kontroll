# Task 10 report: assemble progressive evidence results

## Status

Implemented on `codex/used-car-prototype` from base `1790182f5a90de4a686d9d558797b28abae22987`.

## Delivered

- Added versioned, persisted stage orchestration in `src/analysis/pipeline.ts`. Stages reuse the existing stage names and worker handler shape, read dependency output from `analysis_runs.stage_states`, and write version `1` results through `AnalysesRepository`.
- Added evidence-safe report assembly. Critical and important findings without supplied evidence are dropped with `finding_without_evidence`; context findings remain allowed; action de-duplication keeps one action per normalized intent and finding association. Confidence and verdict are only calculated through the existing Task 2 policy functions when an explicit confidence input is supplied.
- Added the minimal Task 12-facing `Submission` contract and affected-stage selection.
- Added the private report loader and `GET /api/analyses/[publicId]/report`. It revalidates the per-analysis HttpOnly cookie on every request, returns 401 when unauthorized, emits `Cache-Control: private, no-store`, and validates output with `AnalysisReportSchema`.
- Extended only `AnalysesRepository` for run-context/state persistence and report reconstruction. Public warnings are safe codes derived from staged outputs; raw run failures, token hashes, storage keys, and raw source payloads are never returned.
- Transport Administration and manufacturer sources stay `not_checked` when unavailable. Luna image access remains fail-closed without the injected Task 12 capability-verifier/origin seam.

## Files

- Added `src/analysis/pipeline.ts`, `src/analysis/assemble-report.ts`, `src/analysis/affected-stages.ts`.
- Added `src/features/report/load-report.ts` and `src/app/api/analyses/[publicId]/report/route.ts`.
- Modified `src/server/repositories/analyses.ts`.
- Added `tests/unit/analysis/assemble-report.test.ts`, `tests/unit/analysis/affected-stages.test.ts`, `tests/unit/report/load-report.test.ts`, and `tests/integration/progressive-report.test.ts`.

## TDD record

### RED

`npm run test -- tests/unit/analysis/assemble-report.test.ts tests/unit/analysis/affected-stages.test.ts tests/unit/report/load-report.test.ts`

Failed as expected: all three new suites could not resolve their absent production modules.

The initial typecheck then caught the route boundary mismatch: `Property 'cookies' does not exist on type 'Request'`. The route was narrowed to `NextRequest`.

The first executable progressive integration run failed as intended on persisted behavior: the report was `partial`, but `research_pending` and `enrich_pending` warnings were not reconstructed from stage state. `AnalysesRepository.loadReport` now emits only code-shaped staged warnings.

### GREEN

- New assembly, affected-stage, and private-loader tests: 3 files, 8 tests passed.
- Focused progressive integration: 1 file, 1 test passed after the warning reconstruction fix.
- Local Supabase proof: baseline stages published a readable partial report; a later full run became current and complete, with versioned baseline and enrichment state persisted.

## Final verification

All commands were run after the final implementation edit from `~/cars/.worktrees/used-car-prototype`:

```text
npm run test -- tests/unit/analysis
PASS: 4 files, 32 tests

npm run test:integration -- tests/integration/progressive-report.test.ts
PASS: 4 files, 21 tests (local Docker Supabase)

npm run typecheck
PASS: exit 0

npm run test
PASS: 23 files, 157 tests

npm run lint
PASS: exit 0

git diff --check 1790182
PASS: no whitespace errors
```

The first local integration attempt could not contact the sandboxed Supabase CLI; after approved CLI access, Docker was found stopped. Starting Docker Desktop enabled the final local Supabase proof. No live OpenAI call was made.

## Self-review

Reviewed the complete Task 10 implementation directly because the request prohibited subagents. Checked the durable stage dependency flow and final status ordering; evidence filtering and action/finding associations; use of only the Task 2 confidence/verdict policies; private cookie verification before report loading; `no-store` responses; schema validation; warning sanitization; source-key reconstruction; and the Task 9 image-boundary forwarding seam. Also confirmed the final run status remains `complete` after the assembly stage state is saved. No actionable findings remain.

## Concerns and scope limits

- Task 12 must supply opaque image capabilities plus its trusted verifier and allowed storage origins; this task deliberately does not issue or sign image URLs.
- The integration suite requires a running local Docker Supabase instance. It was available for final verification.
- `tests/unit/.DS_Store` remains untracked and unstaged.

## Fix round 1

### Changes

- Rewired the canonical durable graph to publish the deterministic baseline first: `baseline_checks → assemble_report → research → enrich → assemble_report`. Assembly returns an explicit execution result, so only a persisted partial assembly advances to research; a completed or generic assembly cannot loop.
- Made `JobsRepository.enqueue` requeue `assemble_report` only when its existing durable job is already `complete`. A leased/running assembly is untouched, and the integration proof asserts the run retains exactly one assembly job.
- Kept schema-valid Luna warning-only/no-findings output as `complete` with warnings. Provider exceptions and an unavailable provider remain unavailable; warning-only enrichment no longer blocks a complete deterministic report.
- Derived the existing Task 2 confidence input entirely from persisted capture, normalization, and baseline outputs: identity fact confidence, baseline evidence confidence, contradiction state, and captured fact confidence. The progressive worker test proves the resulting `low` confidence and `proceed_cautiously` verdict.
- Allowed only a persisted partial assembly to rerun after enrichment, and persisted only newly enriched findings/actions on that rerun. Baseline records are not inserted twice.

### Test-first record

```text
RED
npm run test -- tests/unit/worker/process-job.test.ts
FAIL: 2 assertions. baseline_checks enqueued research instead of assemble_report;
assemble_report enqueued no durable research stage.

RED
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts
FAIL: after four leased jobs, report status was running instead of partial.

Intermediate RED
The first durable rerun reused the old partial stage result; after permitting that rerun,
duplicate baseline finding persistence left the report running. The rerun now persists only enrichment records.

GREEN
npm run test -- tests/unit/worker/process-job.test.ts tests/unit/analysis
PASS: 5 files, 49 tests

./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts
PASS: 1 file, 1 test (local Docker Supabase)

npm run typecheck
PASS: exit 0

npm run lint
PASS: exit 0
```

### Final verification

The focused worker and progressive integration paths passed after the final edit. The requested broad wrapper command, `npm run test:integration -- tests/integration/progressive-report.test.ts`, starts all integration files and each invokes `npx supabase`; its final attempt failed before test assertions with host npm-cache exhaustion:

```text
npm error code ENOSPC
npm error nospc ... no space left on device ... ~/.npm/_cacache/tmp/...
```

This environmental failure does not affect the focused progressive command above, which passed against the local Docker Supabase instance.

### Self-review

Reviewed this fix range only. Confirmed the graph has one explicit partial-report advance, completed assembly advancement is opt-in, requeue updates only completed jobs, warning-only insight output remains durable and complete, partial reassembly avoids duplicate baseline rows, and confidence/verdict pass only through the Task 2 policy functions. No actionable fix-diff findings remain. `tests/unit/.DS_Store` remains untracked and unstaged.

## Fix round 2

### Changes

- Treated `enrich` as terminal when its persisted result is either `complete` or `unavailable`; a completed research stage plus unavailable enrichment now publishes the deterministic report as `complete` with the safe `enrich_unavailable` warning. Research itself still must complete before final publication.
- On final reassembly, selected enrichment findings and actions from `assembleReport`'s filtered output before calling `EvidenceRepository`. Unsupported important/critical insight findings, and the actions tied to them, are not stored.
- Narrowed completed assembly requeueing in `JobsRepository` to runs whose persisted `assemble_report` state is the durable partial marker (`advanceToResearch: true`). A final assembly state falls back to normal idempotent enqueue and is not reopened; unrelated stages keep their existing enqueue behavior.
- Added local-Supabase integration coverage for missing/throwing enrichment, evidence-less insight persistence, and the enrichment-completion retry interleaving. Added in-process pipeline and repository-boundary regressions because the local Docker service became unavailable before the integration test could start.

### Test-first record

```text
RED
npm run test -- tests/unit/analysis/pipeline.test.ts
FAIL: 2 tests.
- unsupported enrichment finding was passed to saveFindings
- unavailable enrichment produced partial rather than complete assembly

GREEN
npm run test -- tests/unit/analysis tests/unit/server/repositories/jobs.test.ts tests/unit/worker/process-job.test.ts
PASS: 7 files, 54 tests

npm run typecheck
PASS: exit 0
```

### Progressive integration attempt

The amended focused command was started against the real local Supabase flow:

```text
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts
RUN v5.0.0
```

It could not initialize its local client because `npx supabase status -o env` blocked in Docker inspection. The bounded retry emitted:

```text
RUN v5.0.0
progressive integration timed out waiting for local Supabase
```

Read-only checks established the environmental cause without changing Docker state:

```text
node ... docker version --format '{{.Server.Version}}'
spawnSync docker ETIMEDOUT

HTTP GET http://127.0.0.1:54321/rest/v1/
connect ECONNREFUSED 127.0.0.1:54321
```

The bounded retry and its child processes were stopped; no stalled Supabase/Vitest processes remained. The integration test itself remains pending a responsive local Docker Supabase service.

### Self-review

Reviewed this fix range only, including the untracked test additions. Confirmed unavailable enrichment stays warning-only, research availability behavior was not broadened, report filtering is the sole source for final enrichment persistence, actions cannot survive without their retained finding, and only the durable partial assembly state can reopen the single assembly job. No actionable code findings remain. `tests/unit/.DS_Store` remains untracked and unstaged.

### Concerns

- The requested real progressive integration run is blocked by the unavailable local Docker Supabase environment, not a test assertion. Unit/pipeline/worker/repository proof and typecheck are current and passing.

## Fix round 3

### Changes

- Replaced the separate `analysis_runs` read and `analysis_jobs` update with `requeue_partial_assembly_job`, a narrow Postgres RPC that locks the matching run row, checks the durable partial marker, and requeues only the matching completed `assemble_report` job in one transaction.
- Kept generic stage enqueue behavior unchanged. Assembly enqueue falls through to the existing idempotent upsert when the atomic RPC reports that no completed partial assembly was requeued.
- Added a repository regression requiring one atomic RPC and a focused integration regression that forces final state to become durable at the former stale-read/requeue boundary.

### TDD record

```text
RED
npm run test -- tests/unit/server/repositories/jobs.test.ts
FAIL: 1 of 4 tests. Expected requeue_partial_assembly_job RPC; calls: 0.

GREEN
npm run test -- tests/unit/server/repositories/jobs.test.ts
PASS: 1 file, 4 tests

npm run test -- tests/unit/analysis tests/unit/server/repositories/jobs.test.ts tests/unit/worker/process-job.test.ts
PASS: 7 files, 55 tests

npm run typecheck
PASS: exit 0

npm run lint
PASS: exit 0
```

### Migration forward and rollback

- Forward: `202609190001_atomic_assembly_requeue.sql` creates or replaces the data-preserving function. It validates non-null IDs and the run/analysis relationship, uses `SECURITY DEFINER` with `search_path = ''`, revokes execution from `public`, `anon`, and `authenticated`, and grants only `service_role`. It does not alter or delete existing data.
- Rollback: `drop function if exists public.requeue_partial_assembly_job(uuid, uuid);`

### Progressive integration attempt

The pending migration apply was bounded to 45 seconds and returned `ETIMEDOUT`. The required focused integration was then attempted once with a 60-second hard timeout:

```text
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts
RUN v5.0.0 ~/cars/.worktrees/used-car-prototype
ETIMEDOUT
exit 124
```

No test assertion ran because local Supabase initialization did not return. The timeout wrapper terminated the command rather than leaving the task hanging.

### Self-review

Reviewed the complete round-3 diff directly because subagents were prohibited. Checked lock ordering against final stage persistence, exact partial-marker matching, completed-job-only requeue, service-role permissions, fixed search path, input validation, data preservation, idempotent migration replay, rollback, repository error propagation, generic enqueue preservation, and the race-test boundary. No actionable findings remain.

### Concerns

- The real integration regression is present but could not execute while local Docker/Supabase remained unresponsive. Unit, typecheck, lint, and diff checks are current and clean.
- `tests/unit/.DS_Store` remains untracked and unstaged.

## Controller verification after Docker recovery

Applied `202609190001_atomic_assembly_requeue.sql` to the local Supabase test database and reran the focused real-database regression:

```text
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/progressive-report.test.ts
PASS: 1 file, 6 tests
```

The migration and the former stale-read/requeue interleaving are now verified against the local Postgres/Supabase stack. Task 10's implementation, scoped review, static checks, unit tests, and required focused integration gate are complete.
