export const ANALYSIS_STAGES = [
  "capture_listing",
  "normalize_identity",
  "baseline_checks",
  "research",
  "enrich",
  "assemble_report",
] as const;

export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];
// Lookup work has no review-pipeline dependents and is never rerun by a submission.
export const WORKER_STAGES = [...ANALYSIS_STAGES, "background_check"] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

export interface StageExecutionResult {
  enqueueDependents?: boolean;
  deferUntil?: Date;
}

export const STAGE_DEPENDENTS: Record<WorkerStage, readonly AnalysisStage[]> = {
  background_check: [],
  capture_listing: ["normalize_identity"],
  normalize_identity: ["baseline_checks"],
  baseline_checks: ["assemble_report"],
  research: ["enrich"],
  enrich: ["assemble_report"],
  assemble_report: ["research"],
};

export const LONG_RUNNING_STAGES: ReadonlySet<AnalysisStage> = new Set([
  "capture_listing",
  "research",
  "enrich",
]);

export function isAnalysisStage(stage: string): stage is AnalysisStage {
  return (ANALYSIS_STAGES as readonly string[]).includes(stage);
}

export function isWorkerStage(stage:string):stage is WorkerStage {
 return (WORKER_STAGES as readonly string[]).includes(stage);
}
