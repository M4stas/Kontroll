import { calculateConfidence } from "@/domain/confidence";
import { AnalysisReportSchema } from "@/domain/schemas";
import { calculateVerdict } from "@/domain/verdict";
import type {
  Action,
  AnalysisReport,
  AnalysisStatus,
  ConfidenceInput,
  Evidence,
  Finding,
  Locale,
  SourceSummary,
  VehicleFact,
} from "@/domain/analysis";

type SourceState = SourceSummary["verification"] | "unavailable" | SourceSummary;

export interface AssemblyInput {
  review?: import("@/domain/analysis").ReviewProgress;
  publicId: string;
  locale: Locale;
  status: AnalysisStatus;
  vehicleFacts?: VehicleFact[];
  evidence: Evidence[];
  findings: Finding[];
  actions?: Action[];
  sourceStates?: Record<string, SourceState>;
  warnings?: string[];
  confidenceInput?: ConfidenceInput;
  updatedAt: string;
}

function normalizedIntent(action: Action): string {
  return [action.kind, action.title, action.instructions]
    .map((value) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en"))
    .join("\n");
}

function sourceSummary(state: SourceState): SourceSummary {
  if (state === "unavailable") return { verification: "not_checked" };
  if (typeof state === "string") return { verification: state };
  return { ...state, verification: state.verification === "not_checked" ? "not_checked" : state.verification };
}

export function assembleReport(input: AssemblyInput): AnalysisReport {
  const evidenceIds = new Set(input.evidence.map((item) => item.id));
  const warnings = [...new Set(input.warnings ?? [])];
  const findings = input.findings.filter((finding) => {
    if (finding.severity === "context") return true;
    const supported = finding.evidenceIds.length > 0
      && finding.evidenceIds.every((evidenceId) => evidenceIds.has(evidenceId));
    if (!supported && !warnings.includes("finding_without_evidence")) {
      warnings.push("finding_without_evidence");
    }
    return supported;
  });
  const findingIds = new Set(findings.map((finding) => finding.id));
  const seenActions = new Set<string>();
  const actions = (input.actions ?? []).filter((action) => {
    if (action.findingId && !findingIds.has(action.findingId)) return false;
    const key = `${action.findingId ?? ""}\n${normalizedIntent(action)}`;
    if (seenActions.has(key)) return false;
    seenActions.add(key);
    return true;
  });
  const confidence = input.confidenceInput ? calculateConfidence(input.confidenceInput) : null;
  const report: AnalysisReport = {
    publicId: input.publicId,
    ...(input.review ? {review:input.review}:{}),
    status: input.status,
    locale: input.locale,
    verdict: confidence ? calculateVerdict(findings, confidence) : null,
    confidence,
    vehicleFacts: input.vehicleFacts ?? [],
    evidence: input.evidence,
    findings,
    actions,
    sources: Object.fromEntries(
      Object.entries(input.sourceStates ?? {}).map(([key, state]) => [key, sourceSummary(state)]),
    ),
    warnings,
    updatedAt: input.updatedAt,
  };
  return AnalysisReportSchema.parse(report);
}
