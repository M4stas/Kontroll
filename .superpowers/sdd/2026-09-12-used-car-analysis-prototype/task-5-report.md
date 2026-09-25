# Task 5 report: durable worker leasing and staged execution

## Status

Implemented and verified in commit `832becabb16d125b386377a1dcb24614a216fcc4` (`feat(worker): process retryable analysis stages`).

## Implementation

- Added the six typed analysis stage names and a minimal linear dependency graph. The linear policy gives every queued stage a single durable prerequisite and avoids prematurely running join stages.
- Added `processJob(job, deps)` with worker-owned completion, retry, renewal, and failure transitions.
- Added exact transient retry delays of 15 seconds, 60 seconds, and 5 minutes. These are the three retry opportunities; the next transient failure is terminal.
- Added a terminal transient-failure policy that durably enqueues `assemble_report` before marking the failed stage terminal, allowing a partial report without an in-memory queue.
- Added 30-second lease renewal for the long-running `research` and `enrich` stages. An in-flight renewal write is awaited before stage processing returns.
- Added a worker loop that leases one job at a time, waits one second only after an empty lease, and uses an abort signal wired to SIGTERM. Once a job/write is in progress, shutdown waits for it to finish.
- Extended `JobsRepository` with idempotent durable enqueueing. It uses the existing `(analysis_id, run_id, stage)` conflict target and the existing deterministic idempotency-key convention.
- Disabled integration-test file parallelism because both Supabase integration files intentionally clear shared tables between tests; this preserves isolation without affecting the default unit configuration.

## RED/GREEN evidence

1. RED: `npm run test -- tests/unit/worker/process-job.test.ts`
   - Exit 1 as expected: `@/worker/process-job` could not be resolved because the worker module did not exist.
2. Intermediate RED: the first implementation run executed 7 tests, with 2 failures. Both identified a test-fixture wiring error: a handler supplied for `capture_listing` was not supplied for the exercised `research` stage. The fixture was corrected before behavior changes continued.
3. GREEN: `npm run test -- tests/unit/worker/process-job.test.ts`
   - Exit 0: 1 file passed, 7 tests passed.
4. RED: after adding worker-loop tests, `npm run test -- tests/unit/worker/process-job.test.ts`
   - Exit 1 as expected: `@/worker` could not be resolved because the loop module did not exist.
5. GREEN: `npm run test -- tests/unit/worker`
   - Exit 0: 1 file passed, 9 tests passed.
6. Integration diagnosis: the first `npm run test:integration -- tests/integration/job-leasing.test.ts` could not invoke the Supabase CLI in the restricted network environment. The approved rerun reached local Supabase; the new leasing file passed, while the pre-existing schema file raced with its cleanup because the package script selected both files.
7. Integration GREEN after serializing integration files: `npm run test:integration -- tests/integration/job-leasing.test.ts`
   - Exit 0: 2 files passed, 14 tests passed. This includes concurrent leases returning distinct job IDs and duplicate dependent enqueue requests producing one row.

## Final verification

- `npm run test` — exit 0; 13 files passed, 67 tests passed.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `git diff --check` — exit 0.

## Files changed

- `src/analysis/stages.ts`
- `src/worker/index.ts`
- `src/worker/process-job.ts`
- `src/server/repositories/jobs.ts`
- `tests/unit/worker/process-job.test.ts`
- `tests/integration/job-leasing.test.ts`
- `vitest.integration.config.ts`

## Self-review

- Reviewed the exact `832beca` diff with `git show --check` and against every Task 5 requirement.
- Confirmed every lease transition retains `workerId`; there is no stale-worker bypass in `processJob`.
- Confirmed dependent jobs are persisted before the parent lease is released, and duplicate enqueueing is absorbed by existing database uniqueness rather than process memory.
- Confirmed terminal transient failure queues `assemble_report` before failing the exhausted job, so a crash cannot leave the partial-report path permanently absent after the failure write.
- Confirmed the loop has no idle delay after a real job and does not start another lease after shutdown while a current write is draining.
- Confirmed integration tests remain excluded from the default test configuration.
- No correctness, security, or scope findings remained after review.

## Concerns

- The three required retry delays imply three scheduled retries, so terminal failure occurs on the following lease attempt. This is the only policy that keeps all three specified delays reachable.
- Stage handlers themselves remain injected dependencies; parser, research, agent, report assembly, and UI behavior are intentionally not implemented in this task.

---

## Fix round 1/5

### Findings addressed

1. `process-job.ts:110`: an enqueue database error was being handled as a permanent stage failure. Stage execution and post-stage database progression are now separate error boundaries. Enqueue, completion, and lease-renewal failures requeue the owned job with the applicable retry delay, capped at five minutes after the normal retry schedule, instead of terminally failing successful stage work.
2. `process-job.ts:122`: permanent `research` and `enrich` failures now durably enqueue `assemble_report` before failing the optional stage, preserving the partial-report path after deterministic baseline work.

No repository or migration behavior changed in this round. Existing `JobsRepository.enqueue` database uniqueness remains the durable idempotency mechanism, and every retry/fail/renew/complete transition still receives `workerId`.

### RED evidence

Command:

```text
npm run test -- tests/unit/worker/process-job.test.ts
```

Result: exit 1; 13 tests ran, 4 failed and 9 passed. The two permanent optional-stage cases failed because `enqueue` had zero calls. The enqueue and complete database-error cases failed because `retry` had zero calls. These were the expected failures for the two review findings.

### GREEN and verification evidence

Command:

```text
npm run test -- tests/unit/worker/process-job.test.ts
```

Result after the behavior fix: exit 0; 1 file passed, 13 tests passed.

Initial gate commands:

```text
npm run typecheck
npm run lint
```

Results: typecheck exited 2 with `src/worker/process-job.ts(120,30): error TS18048: 'retryDelay' is possibly 'undefined'`; lint exited 0. The type error came from tuple-index fallback inference and was corrected with an explicit five-minute infrastructure retry cap.

Focused rerun after that correction:

```text
npm run test -- tests/unit/worker/process-job.test.ts
```

Result: exit 0; 1 file passed, 13 tests passed.

Final gates:

```text
npm run typecheck
npm run lint
```

Results: both exited 0 with no diagnostics. `git diff --check` also exited 0. Full unit and integration suites were not rerun because this round did not amend repository or migration behavior, as allowed by the fix requirements.

### Files changed

- `src/worker/process-job.ts`
- `tests/unit/worker/process-job.test.ts`

### Self-review

- Checked both review findings against the final diff and regression tests.
- Confirmed stage retry exhaustion behavior remains unchanged.
- Confirmed infrastructure failures never call `fail`; they call the worker-owned `retry` transition and retain a durable database retry path.
- Confirmed failed partial-report enqueueing requeues the source job rather than recording failure without a report job.
- Confirmed only permanent `research` and `enrich` failures receive the new optional-stage continuation policy; deterministic-stage permanent failures retain their previous terminal behavior.
- Confirmed no in-memory queue, ownership bypass, repository change, migration, or later-task behavior was introduced.
- No additional correctness findings remain.

### Commit

`091d52aec7fb11e9f3960b2075b2ea6e0f712a37` — `fix(worker): preserve durable stage progression`

Post-commit self-review used `git show --check --stat --oneline 091d52a` and the complete two-file diff. It found no additional issues; the commit contains only the intended worker behavior and regression tests.

### Concerns

- A database transition that has already committed but whose response is lost can make the follow-up retry transition reject its live-lease check. That rejection is surfaced rather than bypassing ownership; the durable row remains authoritative and is recoverable by normal leasing state.
- An unrelated untracked `tests/unit/.DS_Store` was present before this round and was left untouched.
