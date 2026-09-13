import {
  isAnalysisStage,
  LONG_RUNNING_STAGES,
  STAGE_DEPENDENTS,
  type AnalysisStage,
} from "@/analysis/stages";
import type { AnalysisJob } from "@/server/repositories/jobs";

const RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;
const MAX_INFRASTRUCTURE_RETRY_DELAY_MS = 300_000;
const LEASE_SECONDS = 60;
const RENEW_INTERVAL_MS = 30_000;
const OPTIONAL_REPORT_STAGES: ReadonlySet<AnalysisStage> = new Set([
  "research",
  "enrich",
]);

interface EnqueueJob {
  analysisId: string;
  runId: string;
  stage: AnalysisStage;
}

export interface WorkerDependencies {
  workerId: string;
  jobs: {
    complete(jobId: string, workerId: string): Promise<void>;
    enqueue(job: EnqueueJob): Promise<void>;
    fail(jobId: string, workerId: string, message: string): Promise<void>;
    renew(jobId: string, workerId: string, leaseSeconds: number): Promise<void>;
    retry(
      jobId: string,
      workerId: string,
      availableAt: Date,
      message: string,
    ): Promise<void>;
  };
  stages: Record<AnalysisStage, (job: AnalysisJob) => Promise<void>>;
  now?: () => Date;
}

interface TransientError extends Error {
  transient: true;
}

class WorkerInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}

function isTransientError(error: unknown): error is TransientError {
  return error instanceof Error && "transient" in error && error.transient === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function enqueueDependents(
  job: AnalysisJob,
  stages: readonly AnalysisStage[],
  deps: WorkerDependencies,
): Promise<void> {
  for (const stage of stages) {
    await deps.jobs.enqueue({
      analysisId: job.analysisId,
      runId: job.runId,
      stage,
    });
  }
}

async function executeStage(
  job: AnalysisJob,
  stage: AnalysisStage,
  deps: WorkerDependencies,
): Promise<void> {
  if (!LONG_RUNNING_STAGES.has(stage)) {
    await deps.stages[stage](job);
    return;
  }

  let renewalFailure: unknown;
  let renewalInFlight: Promise<void> = Promise.resolve();
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing || renewalFailure !== undefined) return;
    renewing = true;
    renewalInFlight = deps.jobs
      .renew(job.id, deps.workerId, LEASE_SECONDS)
      .catch((error: unknown) => {
        renewalFailure = error;
      })
      .finally(() => {
        renewing = false;
      });
  }, RENEW_INTERVAL_MS);

  try {
    await deps.stages[stage](job);
  } finally {
    clearInterval(renewal);
    await renewalInFlight;
  }

  if (renewalFailure !== undefined) throw new WorkerInfrastructureError(renewalFailure);
}

async function retryInfrastructureFailure(
  job: AnalysisJob,
  error: unknown,
  deps: WorkerDependencies,
): Promise<void> {
  const retryDelay =
    RETRY_DELAYS_MS[job.attempts - 1] ?? MAX_INFRASTRUCTURE_RETRY_DELAY_MS;
  const now = deps.now?.() ?? new Date();
  await deps.jobs.retry(
    job.id,
    deps.workerId,
    new Date(now.getTime() + retryDelay),
    errorMessage(error),
  );
}

async function handleStageFailure(
  job: AnalysisJob & { stage: AnalysisStage },
  error: unknown,
  deps: WorkerDependencies,
): Promise<void> {
  const message = errorMessage(error);
  const retryDelay = RETRY_DELAYS_MS[job.attempts - 1];

  if (isTransientError(error) && retryDelay !== undefined) {
    const now = deps.now?.() ?? new Date();
    await deps.jobs.retry(job.id, deps.workerId, new Date(now.getTime() + retryDelay), message);
    return;
  }

  if (isTransientError(error) || OPTIONAL_REPORT_STAGES.has(job.stage)) {
    try {
      await enqueueDependents(job, ["assemble_report"], deps);
    } catch (enqueueError) {
      await retryInfrastructureFailure(job, enqueueError, deps);
      return;
    }
  }

  await deps.jobs.fail(job.id, deps.workerId, message);
}

export async function processJob(
  job: AnalysisJob,
  deps: WorkerDependencies,
): Promise<void> {
  if (!isAnalysisStage(job.stage)) {
    await deps.jobs.fail(job.id, deps.workerId, `Unknown analysis stage: ${job.stage}`);
    return;
  }

  try {
    await executeStage(job, job.stage, deps);
  } catch (error) {
    if (error instanceof WorkerInfrastructureError) {
      await retryInfrastructureFailure(job, error, deps);
      return;
    }

    await handleStageFailure(job as AnalysisJob & { stage: AnalysisStage }, error, deps);
    return;
  }

  try {
    await enqueueDependents(job, STAGE_DEPENDENTS[job.stage], deps);
    await deps.jobs.complete(job.id, deps.workerId);
  } catch (error) {
    await retryInfrastructureFailure(job, error, deps);
  }
}
