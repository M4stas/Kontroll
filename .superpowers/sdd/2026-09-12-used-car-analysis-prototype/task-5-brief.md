### Task 5: Implement durable worker leasing and staged execution

**Files:**
- Create: `src/analysis/stages.ts`
- Create: `src/worker/index.ts`
- Create: `src/worker/process-job.ts`
- Create: `tests/unit/worker/process-job.test.ts`
- Create: `tests/integration/job-leasing.test.ts`

**Interfaces:**
- Consumes: `JobsRepository.lease`, `complete`, `retry`, and `fail` from Task 3.
- Produces: `processJob(job: AnalysisJob, deps: WorkerDependencies): Promise<void>`.
- Produces stage names: `capture_listing`, `normalize_identity`, `baseline_checks`, `research`, `enrich`, `assemble_report`.

- [ ] **Step 1: Write a failing retry test**

```ts
import { describe, expect, it, vi } from "vitest";
import { processJob } from "@/worker/process-job";

describe("processJob", () => {
  it("retries a transient stage failure without failing the analysis", async () => {
    const jobs = { retry: vi.fn(), complete: vi.fn(), fail: vi.fn() };
    const stages = { capture_listing: vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { transient: true })) };
    await processJob({ id: "job-1", stage: "capture_listing", attempts: 1 } as never, { jobs, stages } as never);
    expect(jobs.retry).toHaveBeenCalledWith("job-1", expect.any(Date), "timeout");
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm run test -- tests/unit/worker/process-job.test.ts`

Expected: FAIL because the worker modules do not exist.

- [ ] **Step 3: Implement stage execution and worker loop**

The worker leases one job, renews the lease for long stages, executes exactly one stage, records stage state, and enqueues declared dependents. Use exponential retry delays of 15 seconds, 60 seconds, and 5 minutes. After three transient failures, mark the stage failed but allow `assemble_report` to produce a partial report where possible.

The worker loop waits one second only when no job is available and responds to SIGTERM by completing the current database write before exiting.

- [ ] **Step 4: Verify exclusive leasing with two worker IDs**

Run:

```bash
npm run test -- tests/unit/worker
npm run test:integration -- tests/integration/job-leasing.test.ts
```

Expected: unit tests pass and concurrent leases return different job IDs.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/stages.ts src/worker tests/unit/worker tests/integration/job-leasing.test.ts
git commit -m "feat(worker): process retryable analysis stages"
```

---

