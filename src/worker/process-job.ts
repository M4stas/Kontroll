import {
  isWorkerStage,
  LONG_RUNNING_STAGES,
  STAGE_DEPENDENTS,
  type AnalysisStage,
  type WorkerStage,
  type StageExecutionResult,
} from "@/analysis/stages";
import type { AnalysisJob } from "@/server/repositories/jobs";

const RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;
const MAX_INFRASTRUCTURE_RETRY_DELAY_MS = 300_000;
const LEASE_SECONDS = 60;
const RENEW_INTERVAL_MS = 30_000;
const OPTIONAL_REPORT_STAGES: ReadonlySet<WorkerStage> = new Set(["research", "enrich"]);

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
    retry(jobId: string, workerId: string, availableAt: Date, message: string): Promise<void>;
  };
  defer?: (job: AnalysisJob, until: Date) => Promise<void>;
  backgroundCheck?: (job: AnalysisJob) => Promise<StageExecutionResult>;
  stages: Record<
    AnalysisStage,
    (job: AnalysisJob, assertLease?: () => void | Promise<void>) => Promise<void | StageExecutionResult>
  >;
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

class CaptureLeaseLostError extends WorkerInfrastructureError {}

function isLeaseLostError(error: unknown): boolean {
  return (
    error instanceof CaptureLeaseLostError ||
    (error instanceof Error && "leaseLost" in error && error.leaseLost === true)
  );
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
  stage: WorkerStage,
  deps: WorkerDependencies,
): Promise<void | StageExecutionResult> {
  if (stage === "background_check") {
    const execute = deps.backgroundCheck ?? (await import("./index")).executeBackgroundCheckJob;
    return execute(job);
  }
  if (!LONG_RUNNING_STAGES.has(stage)) {
    return deps.stages[stage](job);
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

  const assertLease = async () => {
    await renewalInFlight;
    if (renewalFailure !== undefined) throw new CaptureLeaseLostError(renewalFailure);
  };
  let stageResult: void | StageExecutionResult;
  let stageFailure: unknown;
  let stageThrew = false;
  try {
    stageResult = await deps.stages[stage](job, assertLease);
  } catch (error) {
    stageThrew = true;
    stageFailure = error;
    throw error;
  } finally {
    clearInterval(renewal);
    await renewalInFlight;
    // Lease loss takes precedence over ordinary capture failures as well as success.
    if (renewalFailure !== undefined) {
      const cause = stageThrew
        ? new AggregateError([renewalFailure, stageFailure], "Capture lost its lease while the stage failed")
        : renewalFailure;
      throw new CaptureLeaseLostError(cause);
    }
  }

  if (renewalFailure !== undefined) {
    throw new CaptureLeaseLostError(renewalFailure);
  }
  return stageResult;
}

async function retryInfrastructureFailure(job: AnalysisJob, error: unknown, deps: WorkerDependencies): Promise<void> {
  const retryDelay = RETRY_DELAYS_MS[job.attempts - 1] ?? MAX_INFRASTRUCTURE_RETRY_DELAY_MS;
  const now = deps.now?.() ?? new Date();
  await deps.jobs.retry(job.id, deps.workerId, new Date(now.getTime() + retryDelay), errorMessage(error));
}

async function handleStageFailure(
  job: AnalysisJob & { stage: WorkerStage },
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

  if (OPTIONAL_REPORT_STAGES.has(job.stage)) {
    try {
      await enqueueDependents(job, job.stage === "research" ? ["enrich"] : ["assemble_report"], deps);
    } catch (enqueueError) {
      await retryInfrastructureFailure(job, enqueueError, deps);
      return;
    }
  }

  await deps.jobs.fail(job.id, deps.workerId, message);
}

async function processOwnedJob(job: AnalysisJob, deps: WorkerDependencies): Promise<void> {
  if (!isWorkerStage(job.stage)) {
    await deps.jobs.fail(job.id, deps.workerId, `Unknown analysis stage: ${job.stage}`);
    return;
  }

  let stageResult: void | StageExecutionResult;
  try {
    stageResult = await executeStage(job, job.stage, deps);
  } catch (error) {
    // A failed renewal cannot authorize another write; lease expiry enables reclamation.
    if (isLeaseLostError(error)) return;
    if (error instanceof WorkerInfrastructureError || job.stage === "background_check") {
      await retryInfrastructureFailure(job, error, deps);
      return;
    }

    await handleStageFailure(job as AnalysisJob & { stage: WorkerStage }, error, deps);
    return;
  }

  try {
    if (stageResult?.deferUntil) {
      if (deps.defer) await deps.defer(job, stageResult.deferUntil);
      else await (await import("./index")).deferJob(job, deps.workerId, stageResult.deferUntil);
      return;
    }
    const dependents =
      job.stage === "assemble_report"
        ? stageResult?.enqueueDependents === true
          ? STAGE_DEPENDENTS[job.stage]
          : []
        : STAGE_DEPENDENTS[job.stage];
    await enqueueDependents(job, dependents, deps);
    await deps.jobs.complete(job.id, deps.workerId);
  } catch (error) {
    if (isLeaseLostError(error)) return;
    await retryInfrastructureFailure(job, error, deps);
  }
}

/** Lost ownership can occur during the stage or any later job transition. */
export async function processJob(job: AnalysisJob, deps: WorkerDependencies): Promise<void> {
  try {
    await processOwnedJob(job, deps);
  } catch (error) {
    if (!isLeaseLostError(error)) throw error;
  }
}
