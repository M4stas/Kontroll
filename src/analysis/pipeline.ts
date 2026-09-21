import { createHash } from "node:crypto";
import { assembleReport } from "@/analysis/assemble-report";
import { runBaselineChecks, type BaselineResult } from "@/analysis/baseline-checks";
import type { NormalizedVehicle } from "@/analysis/normalize";
import { normalizeVehicle } from "@/analysis/normalize";
import type { AnalysisStage, StageExecutionResult } from "@/analysis/stages";
import type { Action, AnalysisStatus, ConfidenceInput, Evidence, Finding, SourceSummary } from "@/domain/analysis";
import {
  createInsightProvider,
  type InsightEnvironment,
  type InsightImageBoundaryOptions,
  type InsightProvider,
  type InsightResult,
} from "@/insights/provider";
import { createFallbackSnapshot } from "@/listings/fallback";
import type { ListingAdapter, ListingSnapshot } from "@/listings/adapter";
import { officialLinksFor } from "@/research/official-links";
import type { ResearchProvider, VehicleResearch } from "@/research/provider";
import {
  AnalysesRepository,
  type AnalysisRunContext,
  type VersionedStageResult,
} from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import type { AnalysisJob } from "@/server/repositories/jobs";

export type StageResult = VersionedStageResult;

export interface StageContext {
  analysisId: string;
  runId: string;
  stage: AnalysisStage;
  analyses: Pick<AnalysesRepository, "loadRunContext" | "saveStageResult" | "publishRun">;
  evidence: Pick<
    EvidenceRepository,
    "createSourceSnapshot" | "saveVehicleFacts" | "saveEvidence" | "saveFindings" | "saveActions"
  >;
  listingAdapter: ListingAdapter;
  researchProvider?: ResearchProvider;
  insightProvider?: InsightProvider | null;
  insightEnvironment?: InsightEnvironment;
  /**
   * Task 12 supplies the opaque image-capability verifier and allowed origins.
   * Without that injected boundary, Luna receives no image URLs.
   */
  insightImageBoundary?: InsightImageBoundaryOptions;
  now?: () => Date;
}

interface CaptureOutput {
  snapshot: ListingSnapshot;
}

interface NormalizeOutput {
  vehicle: NormalizedVehicle;
}

interface ResearchOutput {
  research?: VehicleResearch;
  sourceStates: Record<string, SourceSummary>;
}

interface EnrichOutput {
  evidence: Evidence[];
  findings: Finding[];
  actions: Action[];
}

interface AssemblyOutput {
  status: AnalysisStatus;
  advanceToResearch: boolean;
  evidenceIds: string[];
}

function stableId(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function result<T>(status: StageResult["status"], output: T, warnings: string[], now: Date): VersionedStageResult<T> {
  return { version: 1, status, output, warnings, completedAt: now.toISOString() };
}

function completed<T>(output: T, warnings: string[], now: Date): VersionedStageResult<T> {
  return result("complete", output, warnings, now);
}

function unavailable<T>(output: T, warnings: string[], now: Date): VersionedStageResult<T> {
  return result("unavailable", output, warnings, now);
}

function outputFor<T>(context: AnalysisRunContext, stage: AnalysisStage): T | undefined {
  const state = context.stageStates[stage];
  return state?.version === 1 && state.status === "complete" ? state.output as T : undefined;
}

function stateFor<T>(context: AnalysisRunContext, stage: AnalysisStage): VersionedStageResult<T> | undefined {
  const state = context.stageStates[stage];
  return state?.version === 1 ? state as VersionedStageResult<T> : undefined;
}

function isTerminalEnrichment(state: VersionedStageResult | undefined): boolean {
  return state?.status === "complete" || state?.status === "unavailable";
}

function requireOutput<T>(context: AnalysisRunContext, stage: AnalysisStage): T {
  const output = outputFor<T>(context, stage);
  if (!output) throw new Error(`${stage} must complete before this stage can run`);
  return output;
}

function snapshotWithSupplements(run: AnalysisRunContext): ListingSnapshot {
  const { snapshot } = requireOutput<CaptureOutput>(run, "capture_listing");
  const corrections = new Map<"vin" | "registrationPlate", AnalysisRunContext["supplements"][number]>();
  for (const supplement of run.supplements) {
    if (supplement.identityCorrection) corrections.set(supplement.identityCorrection, supplement);
  }
  const correctedKeys = new Set([...corrections.keys()].flatMap((field) => (
    field === "vin"
      ? ["vin", "vehicle identification number"]
      : ["registration plate", "registration_plate", "registration number", "registration", "plate", "number plate", "registreerimisnumber", "reg number", "reg nr"]
  )));
  const correctionFacts = [...corrections.entries()].flatMap(([field, supplement]) => (
    supplement.textContent ? [{
      key: field === "vin" ? "vin" : "registration plate",
      value: supplement.textContent,
      sourceId: supplement.sourceSnapshotId,
      verification: "unverified" as const,
      confidence: 0.5,
    }] : []
  ));
  const textClaims = run.supplements.flatMap((supplement) => (
    supplement.textContent && !supplement.identityCorrection
      ? [{
        text: supplement.textContent,
        sourceClass: supplement.providedBy,
        verification: "unverified" as const,
      }]
      : []
  ));
  return {
    ...snapshot,
    facts: [
      ...snapshot.facts.filter((fact) => !correctedKeys.has(fact.key.trim().toLocaleLowerCase("en"))),
      ...correctionFacts,
    ],
    claims: [...snapshot.claims, ...textClaims],
    imageUrls: [
      ...snapshot.imageUrls,
      ...run.supplements.filter((item) => item.kind === "image").flatMap((item) => item.storageKey ? [item.storageKey] : []),
    ],
    screenshotRefs: [
      ...snapshot.screenshotRefs,
      ...run.supplements.filter((item) => item.kind === "screenshot")
        .flatMap((item) => item.storageKey ? [item.storageKey] : []),
    ],
  };
}

function supplementEvidence(run: AnalysisRunContext, now: Date): Evidence[] {
  return run.supplements.map((supplement): Evidence => {
    const supplied = supplement.providedBy === "seller" ? "Seller" : "Buyer";
    const claim = supplement.textContent
      ?? `${supplied}-provided ${supplement.kind} (${supplement.mimeType ?? "unknown type"}) was added for review.`;
    return {
      id: stableId(`${run.analysisId}:${supplement.acceptedRunId ?? run.runId}:supplement:${supplement.id}`),
      sourceId: supplement.sourceSnapshotId,
      sourceClass: supplement.providedBy,
      claim,
      applicability: "User-supplied material for this vehicle; unverified until independently corroborated.",
      confidence: 0.5,
      verification: "unverified",
      capturedAt: supplement.createdAt ?? now.toISOString(),
    };
  });
}

function scopeBaselineToRun(
  analysisId: string,
  runId: string,
  baseline: BaselineResult,
): BaselineResult {
  const evidenceIds = new Map(baseline.evidence.map((item) => [
    item.id,
    stableId(`${analysisId}:${runId}:baseline-evidence:${item.id}`),
  ]));
  const findingIds = new Map(baseline.findings.map((item) => [
    item.id,
    stableId(`${analysisId}:${runId}:baseline-finding:${item.id}`),
  ]));
  return {
    evidence: baseline.evidence.map((item) => ({ ...item, id: evidenceIds.get(item.id) ?? item.id })),
    findings: baseline.findings.map((item) => ({
      ...item,
      id: findingIds.get(item.id) ?? item.id,
      evidenceIds: item.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
    })),
    actions: baseline.actions.map((item) => ({
      ...item,
      id: stableId(`${analysisId}:${runId}:baseline-action:${item.id}`),
      ...(item.findingId ? { findingId: findingIds.get(item.findingId) ?? item.findingId } : {}),
    })),
  };
}

function scopeReportRecordsToRun(
  analysisId: string,
  runId: string,
  findings: Finding[],
  actions: Action[],
): { findings: Finding[]; actions: Action[] } {
  const findingIds = new Map(findings.map((finding) => [
    finding.id,
    stableId(`${analysisId}:${runId}:report-finding:${finding.id}`),
  ]));
  return {
    findings: findings.map((finding) => ({
      ...finding,
      id: findingIds.get(finding.id) ?? finding.id,
    })),
    actions: actions.map((action) => ({
      ...action,
      id: stableId(`${analysisId}:${runId}:report-action:${action.id}`),
      ...(action.findingId ? { findingId: findingIds.get(action.findingId) ?? action.findingId } : {}),
    })),
  };
}

function lowestConfidence(values: readonly number[]): number {
  return values.length > 0 ? Math.min(...values) : 0;
}

function highestConfidence(values: readonly number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

function confidenceInputFromRun(
  run: AnalysisRunContext,
  baseline: BaselineResult,
): ConfidenceInput {
  const { snapshot } = requireOutput<CaptureOutput>(run, "capture_listing");
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const identitySources = [
    ...(vehicle.vin ? vehicle.provenance.vin : []),
    ...(vehicle.registrationPlate ? vehicle.provenance.registrationPlate : []),
  ];
  const identity = highestConfidence(snapshot.facts
    .filter((fact) => identitySources.includes(fact.sourceId))
    .map((fact) => fact.confidence));
  const evidenceConfidence = lowestConfidence(baseline.evidence.map((evidence) => evidence.confidence));
  return {
    identity,
    coverage: evidenceConfidence,
    agreement: baseline.evidence.some((evidence) => evidence.verification === "contradicted")
      ? 0
      : evidenceConfidence,
    freshness: lowestConfidence(snapshot.facts.map((fact) => fact.confidence)),
  };
}

async function persist(
  context: StageContext,
  run: AnalysisRunContext,
  stageResult: StageResult,
): Promise<StageResult> {
  await context.analyses.saveStageResult({
    analysisId: context.analysisId,
    runId: context.runId,
    stage: context.stage,
    stageStates: run.stageStates,
    result: stageResult,
  });
  return stageResult;
}

async function captureListing(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const listingUrl = new URL(run.input.listingUrl);
  const captured = await context.listingAdapter.capture({ url: listingUrl });
  const fallback = captured.type === "fallback_required";
  const initialSnapshot = fallback
    ? createFallbackSnapshot({
      originalListingUrl: listingUrl,
      pastedDescription: run.input.pastedText ?? "",
    })
    : captured;
  const source = await context.evidence.createSourceSnapshot({
    analysisId: context.analysisId,
    runId: context.runId,
    sourceType: initialSnapshot.marketplace,
    sourceUrl: initialSnapshot.sourceUrl,
    capturedAt: initialSnapshot.capturedAt,
    contentHash: initialSnapshot.contentHash,
    extractionStatus: "complete",
  });
  const snapshot: ListingSnapshot = {
    ...initialSnapshot,
    sourceId: source.id,
    facts: initialSnapshot.facts.map((fact) => ({ ...fact, sourceId: source.id })),
  };
  return persist(context, run, completed(
    { snapshot } satisfies CaptureOutput,
    [...snapshot.warnings, ...(fallback ? [`capture_${captured.reason}`] : [])],
    now,
  ));
}

async function normalizeIdentity(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run);
  const vehicle = normalizeVehicle(snapshot);
  await context.evidence.saveVehicleFacts(snapshot.facts.map((fact) => ({
    ...fact,
    analysisId: context.analysisId,
    runId: context.runId,
  })));
  return persist(context, run, completed({ vehicle } satisfies NormalizeOutput, [], now));
}

async function baselineChecks(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run);
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const baseline = scopeBaselineToRun(
    context.analysisId,
    context.runId,
    runBaselineChecks(vehicle, snapshot),
  );
  const supplements = supplementEvidence(run, now);
  baseline.evidence.push(...supplements);
  const currentSupplementIds = new Set(run.supplements
    .filter((item) => (item.acceptedRunId ?? run.runId) === run.runId)
    .map((item) => stableId(`${run.analysisId}:${item.acceptedRunId ?? run.runId}:supplement:${item.id}`)));
  const evidenceToPersist = baseline.evidence.filter((item) => (
    !supplements.some((supplement) => supplement.id === item.id) || currentSupplementIds.has(item.id)
  ));
  await context.evidence.saveEvidence(evidenceToPersist.map((item) => ({
    ...item,
    analysisId: context.analysisId,
    runId: context.runId,
  })));
  return persist(context, run, completed(baseline, [], now));
}

async function research(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const officialLinks = officialLinksFor(vehicle);
  await context.evidence.createSourceSnapshot({
    analysisId: context.analysisId,
    runId: context.runId,
    sourceType: "transportAdministration",
    sourceUrl: officialLinks.transportAdministration.url,
    extractionStatus: "unavailable",
    metadata: {
      report_key: "transportAdministration",
      report_label: officialLinks.transportAdministration.label,
    },
  });
  const sourceStates: Record<string, SourceSummary> = {
    transportAdministration: {
      verification: "not_checked",
      label: officialLinks.transportAdministration.label,
      url: officialLinks.transportAdministration.url,
    },
  };
  if (officialLinks.manufacturer) {
    await context.evidence.createSourceSnapshot({
      analysisId: context.analysisId,
      runId: context.runId,
      sourceType: "manufacturer",
      sourceUrl: officialLinks.manufacturer.url,
      extractionStatus: "unavailable",
    });
    sourceStates.manufacturer = {
      verification: officialLinks.manufacturer.verification,
      label: officialLinks.manufacturer.label,
      url: officialLinks.manufacturer.url,
    };
  }
  if (!context.researchProvider) {
    return persist(context, run, unavailable({ sourceStates } satisfies ResearchOutput, ["research_unavailable"], now));
  }
  try {
    const researchResult = await context.researchProvider.research(vehicle);
    return persist(context, run, completed({ research: researchResult, sourceStates } satisfies ResearchOutput, [], now));
  } catch {
    return persist(context, run, unavailable({ sourceStates } satisfies ResearchOutput, ["research_unavailable"], now));
  }
}

function findingFromInsight(
  analysisId: string,
  runId: string,
  finding: InsightResult["findings"][number],
): { finding: Finding; action: Action } {
  const id = stableId(`${analysisId}:${runId}:insight:${finding.id}`);
  return {
    finding: {
      id,
      category: finding.category,
      severity: finding.severity,
      state: "open",
      title: finding.title,
      explanation: finding.observation,
      nextAction: finding.recommendedAction.instructions,
      evidenceIds: finding.evidenceIds,
      origin: "agent",
    },
    action: {
      id: stableId(`${analysisId}:${runId}:insight-action:${finding.id}`),
      ...finding.recommendedAction,
      status: "open",
      findingId: id,
    },
  };
}

function imageObservationFromInsight(
  analysisId: string,
  runId: string,
  observation: InsightResult["imageObservations"][number],
): { finding: Finding; action: Action } {
  const id = stableId(`${analysisId}:${runId}:image-observation:${observation.imageEvidenceId}:${observation.observation}`);
  return {
    finding: {
      id,
      category: "image_observation",
      severity: "context",
      state: "open",
      title: "Image observation",
      explanation: observation.observation,
      nextAction: observation.recommendedAction.instructions,
      evidenceIds: [observation.imageEvidenceId],
      origin: "agent",
    },
    action: {
      id: stableId(`${analysisId}:${runId}:image-action:${observation.imageEvidenceId}:${observation.observation}`),
      ...observation.recommendedAction,
      status: "open",
      findingId: id,
    },
  };
}

async function enrich(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run);
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const inheritedBaseline = requireOutput<BaselineResult>(run, "baseline_checks");
  const existingEvidenceIds = new Set(inheritedBaseline.evidence.map((item) => item.id));
  const currentSupplementEvidence = supplementEvidence(run, now)
    .filter((item) => !existingEvidenceIds.has(item.id));
  const currentRunEvidence = currentSupplementEvidence.filter((evidence) => run.supplements.some((supplement) => (
    (supplement.acceptedRunId ?? run.runId) === run.runId
      && stableId(`${run.analysisId}:${supplement.acceptedRunId ?? run.runId}:supplement:${supplement.id}`) === evidence.id
  )));
  if (currentRunEvidence.length > 0) {
    await context.evidence.saveEvidence(currentRunEvidence.map((item) => ({
      ...item,
      analysisId: context.analysisId,
      runId: context.runId,
    })));
  }
  const baseline: BaselineResult = {
    ...inheritedBaseline,
    evidence: [...inheritedBaseline.evidence, ...currentSupplementEvidence],
  };
  const provider = context.insightProvider ?? (context.insightEnvironment
    ? createInsightProvider(context.insightEnvironment, context.insightImageBoundary)
    : null);
  if (!provider) {
    return persist(context, run, unavailable({ evidence: currentSupplementEvidence, findings: [], actions: [] } satisfies EnrichOutput, ["enrich_unavailable"], now));
  }
  try {
    const insight = await provider.enrich({
      analysisId: context.analysisId,
      vehicle,
      evidence: baseline.evidence,
      listingText: snapshot.description,
      sellerClaims: snapshot.claims.filter((claim) => claim.sourceClass === "seller").map((claim) => claim.text),
      buyerClaims: snapshot.claims.filter((claim) => claim.sourceClass === "buyer").map((claim) => claim.text),
      documentText: run.supplements
        .filter((item) => item.kind === "document")
        .map((item) => `Unverified ${item.providedBy}-provided document (${item.mimeType ?? "unknown type"}).`),
      screenshotText: run.supplements
        .filter((item) => item.kind === "screenshot")
        .map((item) => `Unverified ${item.providedBy}-provided screenshot (${item.mimeType ?? "unknown type"}).`),
      images: run.supplements.flatMap((item) => item.kind === "image" && item.signedImage ? [{
        evidenceId: stableId(`${run.analysisId}:${item.acceptedRunId ?? run.runId}:supplement:${item.id}`),
        capability: item.signedImage,
      }] : []),
    });
    const pairs = [
      ...insight.findings.map((finding) => findingFromInsight(context.analysisId, context.runId, finding)),
      ...insight.imageObservations.map((observation) => imageObservationFromInsight(context.analysisId, context.runId, observation)),
    ];
    const warnings = insight.warnings.map((warning) => `${warning.stage}_${warning.code}`);
    const stageResult = {
      evidence: currentSupplementEvidence,
      findings: pairs.map((pair) => pair.finding),
      actions: pairs.map((pair) => pair.action),
    };
    return persist(
      context,
      run,
      completed(stageResult, warnings, now),
    );
  } catch {
    return persist(context, run, unavailable({ evidence: currentSupplementEvidence, findings: [], actions: [] } satisfies EnrichOutput, ["enrich_unavailable"], now));
  }
}

async function assemble(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const baselineState = stateFor<BaselineResult>(run, "baseline_checks");
  if (!baselineState || baselineState.status !== "complete") {
    const report = assembleReport({
      publicId: run.publicId,
      locale: run.locale,
      status: "failed",
      evidence: [],
      findings: [],
      warnings: ["baseline_unavailable"],
      updatedAt: now.toISOString(),
    });
    const stageResult = unavailable({
      status: report.status,
      advanceToResearch: false,
      evidenceIds: [],
    } satisfies AssemblyOutput, report.warnings, now);
    await persist(context, run, stageResult);
    await context.analyses.publishRun({
      analysisId: context.analysisId,
      runId: context.runId,
      status: report.status,
      verdict: report.verdict,
      confidence: report.confidence,
      completedAt: now.toISOString(),
    });
    return stageResult;
  }
  const previousAssembly = stateFor<AssemblyOutput>(run, "assemble_report");
  const rerunningPartialAssembly = previousAssembly?.output.advanceToResearch === true;
  const researchState = stateFor<ResearchOutput>(run, "research");
  const enrichState = stateFor<EnrichOutput>(run, "enrich");
  const warnings = [
    ...baselineState.warnings,
    ...(researchState ? researchState.warnings : ["research_pending"]),
    ...(enrichState ? enrichState.warnings : ["enrich_pending"]),
  ];
  const isComplete = researchState?.status === "complete" && isTerminalEnrichment(enrichState);
  const reportEvidence = [...new Map([
    ...baselineState.output.evidence,
    ...(enrichState?.output.evidence ?? []),
  ].map((item) => [item.id, item])).values()];
  const report = assembleReport({
    publicId: run.publicId,
    locale: run.locale,
    status: isComplete ? "complete" : "partial",
    vehicleFacts: [],
    evidence: reportEvidence,
    findings: [...baselineState.output.findings, ...(enrichState?.output.findings ?? [])],
    actions: [...baselineState.output.actions, ...(enrichState?.output.actions ?? [])],
    sourceStates: {
      transportAdministration: researchState?.output.sourceStates.transportAdministration ?? "not_checked",
      ...(researchState?.output.sourceStates ?? {}),
    },
    warnings,
    confidenceInput: confidenceInputFromRun(run, baselineState.output),
    updatedAt: now.toISOString(),
  });
  const reportFindingIds = new Set(report.findings.map((finding) => finding.id));
  const reportActionIds = new Set(report.actions.map((action) => action.id));
  const selectedFindings = rerunningPartialAssembly
    ? (enrichState?.output.findings ?? []).filter((finding) => reportFindingIds.has(finding.id))
    : report.findings;
  const selectedActions = rerunningPartialAssembly
    ? (enrichState?.output.actions ?? []).filter((action) => reportActionIds.has(action.id))
    : report.actions;
  const { findings: findingsToPersist, actions: actionsToPersist } = scopeReportRecordsToRun(
    context.analysisId,
    context.runId,
    selectedFindings,
    selectedActions,
  );
  const findingIds = await context.evidence.saveFindings(findingsToPersist.map((finding) => ({
    ...finding,
    analysisId: context.analysisId,
    runId: context.runId,
    evidenceLinks: finding.evidenceIds
      .filter((evidenceId) => report.evidence.some((evidence) => evidence.id === evidenceId))
      .map((evidenceId) => ({ evidenceId, relation: "supports" as const })),
  })));
  const persistedFindingIds = new Map(findingsToPersist.map((finding, index) => [finding.id, findingIds[index] ?? ""]));
  await context.evidence.saveActions(actionsToPersist.flatMap((action) => {
    const findingId = action.findingId ? persistedFindingIds.get(action.findingId) : undefined;
    if (action.findingId && !findingId) return [];
    return [{
      ...action,
      ...(findingId ? { findingId } : {}),
      analysisId: context.analysisId,
      runId: context.runId,
    }];
  }));
  const stageResult = completed({
    status: report.status,
    advanceToResearch: !researchState,
    evidenceIds: report.evidence.map((item) => item.id),
  } satisfies AssemblyOutput, report.warnings, now);
  await persist(context, run, stageResult);
  await context.analyses.publishRun({
    analysisId: context.analysisId,
    runId: context.runId,
    status: report.status,
    verdict: report.verdict,
    confidence: report.confidence,
    completedAt: now.toISOString(),
  });
  return stageResult;
}

export async function runStage(context: StageContext): Promise<StageResult> {
  const run = await context.analyses.loadRunContext(context.analysisId, context.runId);
  const now = context.now?.() ?? new Date();
  const existing = run.stageStates[context.stage];
  const partialAssembly = context.stage === "assemble_report"
    && (existing?.output as Partial<AssemblyOutput> | undefined)?.advanceToResearch === true;
  if (existing?.version === 1 && existing.status === "complete" && !partialAssembly) return existing;

  switch (context.stage) {
    case "capture_listing":
      return captureListing(context, run, now);
    case "normalize_identity":
      return normalizeIdentity(context, run, now);
    case "baseline_checks":
      return baselineChecks(context, run, now);
    case "research":
      return research(context, run, now);
    case "enrich":
      return enrich(context, run, now);
    case "assemble_report":
      return assemble(context, run, now);
  }
}

export function createStageHandlers(
  context: Omit<StageContext, "analysisId" | "runId" | "stage">,
): Record<AnalysisStage, (job: AnalysisJob) => Promise<void | StageExecutionResult>> {
  return Object.fromEntries(([
    "capture_listing",
    "normalize_identity",
    "baseline_checks",
    "research",
    "enrich",
    "assemble_report",
  ] as const).map((stage) => [stage, async (job: AnalysisJob) => {
    const result = await runStage({ ...context, analysisId: job.analysisId, runId: job.runId, stage });
    if (stage !== "assemble_report") return;
    return {
      enqueueDependents: (result.output as Partial<AssemblyOutput>).advanceToResearch === true,
    };
  }])) as Record<AnalysisStage, (job: AnalysisJob) => Promise<void | StageExecutionResult>>;
}
