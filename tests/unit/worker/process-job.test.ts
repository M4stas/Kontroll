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

  it("fails after three transient research retries and queues enrichment", async () => {
    const deps = dependencies(
      vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { transient: true })),
    );

    await processJob(job({ stage: "research", attempts: 4 }), deps);

    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "timeout");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "enrich",
    });
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  // Catches exhausted capture retries advancing report assembly without required capture evidence.
  it("fails exhausted transient capture without queuing dependents", async () => {
    const deps = dependencies(
      vi.fn().mockRejectedValue(Object.assign(new Error("photos unavailable"), { transient: true })),
    );

    await processJob(job({ attempts: 4 }), deps);

    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "photos unavailable");
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.jobs.complete).not.toHaveBeenCalled();
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  it("queues report assembly after exhausting transient enrichment retries", async () => {
    const deps = dependencies(
      vi.fn().mockRejectedValue(Object.assign(new Error("model unavailable"), { transient: true })),
    );

    await processJob(job({ stage: "enrich", attempts: 4 }), deps);

    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1", runId: "run-1", stage: "assemble_report",
    });
    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "model unavailable");
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  it("fails a permanent stage error without retrying", async () => {
    const deps = dependencies(vi.fn().mockRejectedValue(new Error("invalid listing")));

    await processJob(job(), deps);

    expect(deps.jobs.fail).toHaveBeenCalledWith("job-1", "worker-1", "invalid listing");
    expect(deps.jobs.retry).not.toHaveBeenCalled();
  });

  it.each(["research", "enrich"] as const)(
    "queues the next available stage after a permanent %s failure",
    async (stage) => {
      const deps = dependencies(vi.fn().mockRejectedValue(new Error("provider rejected input")));

      await processJob(job({ stage }), deps);

      expect(deps.jobs.enqueue).toHaveBeenCalledWith({
        analysisId: "analysis-1",
        runId: "run-1",
        stage: stage === "research" ? "enrich" : "assemble_report",
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

    expect(deps.stages.capture_listing).toHaveBeenCalledWith(job(), expect.any(Function));
    expect(deps.jobs.complete).toHaveBeenCalledWith("job-1", "worker-1");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "normalize_identity",
    });
  });

  // Catches baseline completion advancing directly to research, leaving no durable partial report job.
  it("queues report assembly immediately after deterministic baseline checks", async () => {
    const deps = dependencies();

    await processJob(job({ stage: "baseline_checks" }), deps);

    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "assemble_report",
    });
    expect(deps.jobs.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "research" }));
  });

  // Catches a partial assembly job completing without durably advancing the optional research path.
  it("advances partial assembly to research through the durable worker graph", async () => {
    const stage = vi.fn().mockResolvedValue({ enqueueDependents: true });
    const deps = dependencies(stage);

    await processJob(job({ stage: "assemble_report" }), deps);

    expect(deps.jobs.enqueue).toHaveBeenCalledWith({
      analysisId: "analysis-1",
      runId: "run-1",
      stage: "research",
    });
  });

  // Catches a final assembly re-entering the graph and requeuing a duplicate research path.
  it("does not advance dependents after a completed assembly", async () => {
    const stage = vi.fn().mockResolvedValue({ enqueueDependents: false });
    const deps = dependencies(stage);

    await processJob(job({ stage: "assemble_report" }), deps);

    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.jobs.complete).toHaveBeenCalledWith("job-1", "worker-1");
  });

  // Catches a handler without an explicit partial result looping through the cyclic report graph.
  it("requires an explicit partial assembly result before queuing research", async () => {
    const deps = dependencies();

    await processJob(job({ stage: "assemble_report" }), deps);

    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
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

it("renews slow capture acquisition and completes beyond its original lease",async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
 let leaseDeadline=Date.now()+60000;let completed=false;
 const deps=dependencies(vi.fn().mockImplementation(()=>new Promise<void>(resolve=>setTimeout(resolve,95000))));
 deps.jobs.renew.mockImplementation(async()=>{if(Date.now()>=leaseDeadline) throw Error("lease expired");leaseDeadline=Date.now()+60000;});
 deps.jobs.complete.mockImplementation(async()=>{if(Date.now()>=leaseDeadline) throw Error("lease expired");completed=true;});
 const processing=processJob(job(),deps);
 await vi.advanceTimersByTimeAsync(95000);await processing;
 expect(completed).toBe(true);expect(deps.jobs.renew).toHaveBeenCalledTimes(3);expect(deps.jobs.retry).not.toHaveBeenCalled();
});
it("abandons capture persistence and transitions when lease renewal fails",async()=>{
 vi.useFakeTimers();let published=false;
 const deps=dependencies(vi.fn().mockImplementation(async(_job,assertLease?:()=>void | Promise<void>)=>{await new Promise<void>(resolve=>setTimeout(resolve,70000));await assertLease?.();published=true;}));
 deps.jobs.renew.mockRejectedValue(Error("lease lost"));
 const processing=processJob(job(),deps);
 await vi.advanceTimersByTimeAsync(70000);await processing;
 expect(published).toBe(false);expect(deps.jobs.complete).not.toHaveBeenCalled();expect(deps.jobs.enqueue).not.toHaveBeenCalled();expect(deps.jobs.retry).not.toHaveBeenCalled();expect(deps.jobs.fail).not.toHaveBeenCalled();
});

it("abandons lost capture lease even when acquisition also throws an ordinary stage error",async()=>{
 vi.useFakeTimers();
 const deps=dependencies(vi.fn().mockImplementation(async()=>{await new Promise<void>(resolve=>setTimeout(resolve,70000));throw Error("private storage failed");}));
 deps.jobs.renew.mockRejectedValue(Error("lease lost"));
 deps.jobs.fail.mockRejectedValue(Error("expired lease cannot fail job"));
 const processing=processJob(job(),deps);
 const result=processing.then(()=>"settled",()=>"rejected");
 await vi.advanceTimersByTimeAsync(70000);
 expect(await result).toBe("settled");
 expect(deps.jobs.fail).not.toHaveBeenCalled();expect(deps.jobs.retry).not.toHaveBeenCalled();expect(deps.jobs.enqueue).not.toHaveBeenCalled();expect(deps.jobs.complete).not.toHaveBeenCalled();
});
it('abandons canceled review ownership without retrying or failing its former lease',async()=>{
 const deps=dependencies(vi.fn().mockRejectedValue(Object.assign(new Error('Review run superseded'),{leaseLost:true})));
 await processJob(job({stage:'enrich'}),deps);
 expect(deps.jobs.fail).not.toHaveBeenCalled();expect(deps.jobs.retry).not.toHaveBeenCalled();expect(deps.jobs.enqueue).not.toHaveBeenCalled();expect(deps.jobs.complete).not.toHaveBeenCalled();
});
it('abandons completion after a successful stage is superseded',async()=>{
 const deps=dependencies();deps.jobs.complete.mockRejectedValue(Object.assign(new Error('active lease not found'),{leaseLost:true}));
 await expect(processJob(job({stage:'enrich'}),deps)).resolves.toBeUndefined();
 expect(deps.jobs.retry).not.toHaveBeenCalled();expect(deps.jobs.fail).not.toHaveBeenCalled();
});
it.each(['fail','retry'] as const)('abandons ownership lost during nested %s transition',async transition=>{
 const deps=dependencies(vi.fn().mockRejectedValue(Object.assign(new Error('stage failure'),transition==='retry'?{transient:true}:{})));
 deps.jobs[transition].mockRejectedValue(Object.assign(new Error('active lease not found'),{leaseLost:true}));
 await expect(processJob(job({stage:'enrich'}),deps)).resolves.toBeUndefined();
});
