import type { AnalysisJob } from "@/server/repositories/jobs";

const DEFAULT_LEASE_SECONDS = 60;
const IDLE_WAIT_MS = 1_000;

export interface WorkerLoopDependencies {
  workerId: string;
  leaseSeconds?: number;
  lease(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null>;
  process(job: AnalysisJob): Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runWorkerLoop(
  deps: WorkerLoopDependencies,
  signal: AbortSignal,
): Promise<void> {
  const idleWait = deps.wait ?? wait;

  while (!signal.aborted) {
    const job = await deps.lease(
      deps.workerId,
      deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    );

    if (job) {
      await deps.process(job);
      continue;
    }

    if (!signal.aborted) await idleWait(IDLE_WAIT_MS);
  }
}

export async function runUntilSigterm(deps: WorkerLoopDependencies): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);

  try {
    await runWorkerLoop(deps, controller.signal);
  } finally {
    process.off("SIGTERM", stop);
  }
}
