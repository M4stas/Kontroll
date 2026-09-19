export const ANALYSIS_STAGES = [
  "capture_listing",
  "normalize_identity",
  "baseline_checks",
  "research",
  "enrich",
  "assemble_report",
] as const;

export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export interface StageExecutionResult {
  enqueueDependents?: boolean;
}

export const STAGE_DEPENDENTS: Record<AnalysisStage, readonly AnalysisStage[]> = {
  capture_listing: ["normalize_identity"],
  normalize_identity: ["baseline_checks"],
  baseline_checks: ["assemble_report"],
  research: ["enrich"],
  enrich: ["assemble_report"],
  assemble_report: ["research"],
};

export const LONG_RUNNING_STAGES: ReadonlySet<AnalysisStage> = new Set([
  "research",
  "enrich",
]);

export function isAnalysisStage(stage: string): stage is AnalysisStage {
  return (ANALYSIS_STAGES as readonly string[]).includes(stage);
}
