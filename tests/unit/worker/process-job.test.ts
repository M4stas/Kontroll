import { afterEach, describe, expect, it, vi } from "vitest";
import { processJob } from "@/worker/process-job";
import { runWorkerLoop } from "@/worker";
import type { AnalysisJob } from "@/server/repositories/jobs";

function job(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: "job-1",
    analysisId: "analysis-1",
    runId: "run-1",
    stage: "capture_listing",
    status: "leased",
    attempts: 1,
    leasedBy: "worker-1",
    leaseExpiresAt: "2026-09-13T12:01:00.000Z",
    availableAt: "2026-09-13T12:00:00.000Z",
    lastError: null,
    createdAt: "2026-09-13T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function dependencies(stage = vi.fn().mockResolvedValue(undefined)) {
  return {
    workerId: "worker-1",
    jobs: {
      complete: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
    },
    stages: {
      capture_listing: stage,
      normalize_identity: stage,
      baseline_checks: stage,
      research: stage,
      enrich: stage,
      assemble_report: stage,
    },
    now: () => new Date("2026-09-13T12:00:00.000Z"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("processJob", () => {
  it.each([
    [1, 15_000],
    [2, 60_000],
    [3, 300_000],
  ])("retries transient attempt %i after %i milliseconds", async (attempts, delay) => {
    const deps = dependencies(
      vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { transient: true })),
    );

    await processJob(job({ attempts }), deps);

    expect(deps.jobs.retry).toHaveBeenCalledWith(
      "job-1",
      "worker-1",
      new Date(Date.parse("2026-09-13T12:00:00.000Z") + delay),
      "timeout",
    );
    expect(deps.jobs.fail).not.toHaveBeenCalled();
  });

  it("fails after three transient retries and durably queues a partial report", async () => {
    const deps = dependencies(
      vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { transient: true })),
    );

    await processJob(job({ stage: "research", attempts: 4 }), deps);

    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "timeout");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "assemble_report",
    });
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  it("fails a permanent stage error without retrying", async () => {
    const deps = dependencies(vi.fn().mockRejectedValue(new Error("invalid listing")));

    await processJob(job(), deps);

    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "invalid listing");
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  it.each(["research", "enrich"] as const)(
    "queues a partial report after a permanent %s failure",
    async (stage) => {
      const deps = dependencies(vi.fn().mockRejectedValue(new Error("provider rejected input")));

      await processJob(job({ stage }), deps);

      expect(deps.jobs.enqueue).toHaveBeenCalledWith({
        analysisId: "analysis-1",
        runId: "run-1",
        stage: "assemble_report",
      });
      expect(deps.jobs.fail).toHaveBeenCalledWith(
        "job-1",
        "worker-1",
        "provider rejected input",
      );
    },
  );

  it("completes one stage and durably enqueues its declared dependent", async () => {
    const deps = dependencies();

    await processJob(job(), deps);

    expect(deps.stages.capture_listing).toHaveBeenCalledWith(job());
    expect(deps.jobs.complete).toHaveBeenCalledWith("job-1", "worker-1");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "normalize_identity",
    });
  });

  it.each(["enqueue", "complete"] as const)(
    "retries a post-stage %s database failure without failing the stage",
    async (operation) => {
      const deps = dependencies();
      deps.jobs[operation].mockRejectedValue(new Error("database unavailable"));

      await processJob(job(), deps);

      expect(deps.jobs.retry).toHaveBeenCalledWith(
        "job-1",
        "worker-1",
        new Date("2026-09-13T12:00:15.000Z"),
        "database unavailable",
      );
      expect(deps.jobs.fail).not.toHaveBeenCalled();
    },
  );

  it("renews the lease while a long stage is still running", async () => {
    vi.useFakeTimers();
    let finishStage: (() => void) | undefined;
    const deps = dependencies(
      vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          finishStage = resolve;
        }),
      ),
    );

    const processing = processJob(job({ stage: "research" }), deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deps.jobs.renew).toHaveBeenCalledWith("job-1", "worker-1", 60);
    finishStage?.();
    await processing;
  });
});

describe("runWorkerLoop", () => {
  it("waits one second only when no job is available", async () => {
    const controller = new AbortController();
    const waiting = vi.fn().mockImplementation(async (milliseconds: number) => {
      expect(milliseconds).toBe(1_000);
      controller.abort();
    });
    const lease = vi.fn().mockResolvedValue(null);

    await runWorkerLoop(
      {
        lease,
        process: vi.fn(),
        wait: waiting,
        workerId: "worker-1",
      },
      controller.signal,
    );

    expect(lease).toHaveBeenCalledWith("worker-1", 60);
    expect(waiting).toHaveBeenCalledOnce();
  });

  it("finishes the current job write after shutdown is requested", async () => {
    const controller = new AbortController();
    let finishWrite: (() => void) | undefined;
    const currentWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const leasedJob = job();
    const lease = vi.fn().mockResolvedValueOnce(leasedJob).mockResolvedValue(null);
    const process = vi.fn().mockImplementation(async () => currentWrite);

    const running = runWorkerLoop(
      { lease, process, wait: vi.fn(), workerId: "worker-1" },
      controller.signal,
    );
    await vi.waitFor(() => expect(process).toHaveBeenCalledWith(leasedJob));
    controller.abort();

    let exited = false;
    void running.then(() => {
      exited = true;
    });
    await Promise.resolve();
    expect(exited).toBe(false);

    finishWrite?.();
    await running;
    expect(lease).toHaveBeenCalledOnce();
  });
});
