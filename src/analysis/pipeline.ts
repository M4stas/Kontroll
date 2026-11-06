import { PhotoTimingRecorder, runPhotoTimingJob } from "@/diagnostics/photo-timings";
import { stableId, supplementEvidenceId } from "@/lib/stable-id";
import type { PhotoSpan } from "@/diagnostics/contracts";
import { assembleReport } from "@/analysis/assemble-report";
import { runBaselineChecks, type BaselineResult } from "@/analysis/baseline-checks";
import type { NormalizedVehicle } from "@/analysis/normalize";
import { normalizeVehicle } from "@/analysis/normalize";
import type { AnalysisStage, StageExecutionResult } from "@/analysis/stages";
import type { Action, AnalysisStatus, ConfidenceInput, Evidence, Finding, SourceSummary } from "@/domain/analysis";
import { createDataReviewer, type InsightEnvironment, type InsightImageBoundaryOptions } from "@/insights/provider";
import { createFallbackSnapshot } from "@/listings/fallback";
import type { ListingAdapter, ListingSnapshot } from "@/listings/adapter";
import { officialLinksFor } from "@/research/official-links";
import { AnalysesRepository, type AnalysisRunContext, type VersionedStageResult } from "@/server/repositories/analyses";
import { runBackgroundCheckFindings } from "@/analysis/background-check-findings";
import type { getBackgroundCheck } from "@/server/repositories/background-checks";
import { EvidenceRepository, type SourceSnapshotInput } from "@/server/repositories/evidence";
import type { AnalysisJob } from "@/server/repositories/jobs";

import { resolveReviewConfig, resolveProductionReviewConfig, isProductionImageSettingsAllowed } from "@/config/review";
import type { ReviewProgress } from "@/domain/analysis";
import type { DataReviewer } from "@/insights/types";
import { ReviewDeferredError } from "@/analysis/review-coordinator";
import { reviewRun } from "@/analysis/review-run";
import type { ReviewExecutionsRepository, ReviewPassPin, ReviewRunSnapshot } from "@/server/repositories/review-executions";

export type StageResult = VersionedStageResult;

export interface StageContext {
  analysisId: string;
  runId: string;
  stage: AnalysisStage;
  analyses: Pick<AnalysesRepository, "loadRunContext" | "saveStageResult" | "finalizeAssembly" | "loadAgentRecords">;
  evidence: Pick<
    EvidenceRepository,
    | "createSourceSnapshot"
    | "saveSourceSnapshots"
    | "saveVehicleFacts"
    | "saveEvidence"
    | "saveFindings"
    | "saveActions"
  >;
  listingAdapter: ListingAdapter;
  prepareListingPhotos?: (
    analysisId: string,
    urls: readonly string[],
  ) => Promise<import("@/listings/photos").ListingPhotoPreparation>;
  insightEnvironment?: InsightEnvironment;
  insightImageBoundary?: InsightImageBoundaryOptions;
  photoTimings?: { enabled: boolean; write(job: AnalysisJob, spans: PhotoSpan[], signal: AbortSignal): Promise<void> };
  now?: () => Date;
  getBackgroundCheck?: typeof getBackgroundCheck;
  assertLease?: () => void | Promise<void>;
  jobId?: string;
  workerId?: string;
  reviewExecutions?: ReviewExecutionsRepository;
  dataReviewer?: (pin: ReviewPassPin) => DataReviewer;
  reviewImageCapability?: (
    analysisId: string,
    evidenceId: string,
    storageKey: string,
    contentHash: string,
  ) => Promise<unknown>;
}

interface CaptureOutput {
  ownerRunId?: string;
  snapshot: ListingSnapshot;
}

interface NormalizeOutput {
  vehicle: NormalizedVehicle;
}

interface ResearchOutput {
  sourceStates: Record<string, SourceSummary>;
}

interface EnrichOutput {
  review?: ReviewProgress;
  evidence: Evidence[];
  findings: Finding[];
  actions: Action[];
}

interface AssemblyOutput {
  status: AnalysisStatus;
  advanceToResearch: boolean;
  evidenceIds: string[];
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
  return state?.version === 1 && state.status === "complete" ? (state.output as T) : undefined;
}

function stateFor<T>(context: AnalysisRunContext, stage: AnalysisStage): VersionedStageResult<T> | undefined {
  const state = context.stageStates[stage];
  return state?.version === 1 ? (state as VersionedStageResult<T>) : undefined;
}

function isTerminalEnrichment(state: VersionedStageResult | undefined): boolean {
  return state?.status === "complete" || state?.status === "unavailable";
}

function requireOutput<T>(context: AnalysisRunContext, stage: AnalysisStage): T {
  const output = outputFor<T>(context, stage);
  if (!output) throw new Error(`${stage} must complete before this stage can run`);
  return output;
}

function snapshotWithSupplements(run: AnalysisRunContext, rebuildingBaseline = false): ListingSnapshot {
  const capture = requireOutput<CaptureOutput>(run, "capture_listing");
  const { snapshot } = capture;
  const inheritedCapture = capture.ownerRunId
    ? capture.ownerRunId !== run.runId
    : snapshot.sourceId !== stableId(`${run.analysisId}:${run.runId}:capture-source`);
  const inheritedBaseline = outputFor<BaselineResult & { captureCitationRunId?: string }>(run, "baseline_checks");
  const inheritedBaselineIds = new Set(inheritedBaseline?.evidence.map((item) => item.id) ?? []);
  const citationRunId = rebuildingBaseline ? run.runId : (inheritedBaseline?.captureCitationRunId ?? run.runId);
  // Baseline reruns copy citations into the new run while retaining their source.
  // Image-only reruns retain citations already present in their inherited baseline.
  const citationId = (id: string) =>
    inheritedCapture && (rebuildingBaseline || !inheritedBaselineIds.has(id))
      ? stableId(`${run.analysisId}:${citationRunId}:capture-citation:${id}`)
      : id;
  const corrections = new Map<"vin" | "registrationPlate", AnalysisRunContext["supplements"][number]>();
  for (const supplement of run.supplements) {
    if (supplement.identityCorrection) corrections.set(supplement.identityCorrection, supplement);
  }
  const correctedKeys = new Set(
    [...corrections.keys()].flatMap((field) =>
      field === "vin"
        ? ["vin", "vehicle identification number"]
        : [
            "registration plate",
            "registration_plate",
            "registration number",
            "registration",
            "plate",
            "number plate",
            "registreerimisnumber",
            "reg number",
            "reg nr",
          ],
    ),
  );
  const correctionFacts = [...corrections.entries()].flatMap(([field, supplement]) =>
    supplement.textContent
      ? [
          {
            key: field === "vin" ? "vin" : "registration plate",
            value: supplement.textContent,
            sourceId: supplement.sourceSnapshotId,
            verification: "unverified" as const,
            confidence: 0.5,
          },
        ]
      : [],
  );
  const textClaims = run.supplements.flatMap((supplement) =>
    supplement.textContent &&
    !supplement.identityCorrection &&
    !(supplement.kind === "document" && supplement.mimeType === "application/pdf") &&
    !(snapshot.marketplace === "fallback" && supplement.kind === "buyer_note" && supplement.providedBy === "buyer")
      ? [
          {
            text: supplement.textContent,
            sourceClass: supplement.providedBy,
            verification: "unverified" as const,
          },
        ]
      : [],
  );
  return {
    ...snapshot,
    ...(snapshot.sourceRecords
      ? {
          sourceRecords: snapshot.sourceRecords.map((record) => ({
            ...record,
            evidenceId: citationId(record.evidenceId),
          })),
        }
      : {}),
    ...(snapshot.photoPreparation
      ? {
          photoPreparation: {
            ...snapshot.photoPreparation,
            images: snapshot.photoPreparation.images.map((image) => ({
              ...image,
              evidenceId: citationId(image.evidenceId),
            })),
          },
        }
      : {}),
    facts: [
      ...snapshot.facts.filter((fact) => !correctedKeys.has(fact.key.trim().toLocaleLowerCase("en"))),
      ...correctionFacts,
    ],
    claims: [...snapshot.claims, ...textClaims],
    imageUrls: [
      ...snapshot.imageUrls,
      ...run.supplements
        .filter((item) => item.kind === "image")
        .flatMap((item) => (item.storageKey ? [item.storageKey] : [])),
    ],
    screenshotRefs: [
      ...new Set([
        ...snapshot.screenshotRefs,
        ...run.supplements
          .filter((item) => item.kind === "screenshot")
          .flatMap((item) => (item.storageKey ? [item.storageKey] : [])),
      ]),
    ],
  };
}

function supplementEvidence(run: AnalysisRunContext, now: Date): Evidence[] {
  return run.supplements.map((supplement): Evidence => {
    const supplied = supplement.providedBy === "seller" ? "Seller" : "Buyer";
    const claim =
      (supplement.kind === "document" && supplement.mimeType === "application/pdf" ? "Untrusted user-uploaded PDF document; extracted page text supplied only for final assessment." : supplement.textContent) ??
      `${supplied}-provided ${supplement.kind} (${supplement.mimeType ?? "unknown type"}) was added for review.`;
    return {
      id: supplementEvidenceId(run.analysisId, run.runId, supplement),
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

async function persistSupplementEvidence(
  context: StageContext,
  run: AnalysisRunContext,
  supplements: Evidence[],
  currentEvidence: Evidence[] = [],
): Promise<void> {
  // A newer supplement run can supersede an ancestor before its enrich stage.
  // Materialize every admitted supplement in its accepting run, matching its ID
  // and source ownership, before durable review can link findings to it.
  const evidenceByRun = new Map<string, Evidence[]>([[run.runId, [...currentEvidence]]]);
  for (const [index, supplement] of run.supplements.entries()) {
    const ownerRunId = supplement.acceptedRunId ?? run.runId;
    const evidence = supplements[index]!;
    const ownedEvidence = evidenceByRun.get(ownerRunId) ?? [];
    ownedEvidence.push(evidence);
    evidenceByRun.set(ownerRunId, ownedEvidence);
  }
  for (const [ownerRunId, evidence] of evidenceByRun) {
    // Re-materializing an ancestor's supplements must retain its pinned VIN citation.
    if (ownerRunId !== run.runId && context.reviewExecutions) {
      const pinned = await context.reviewExecutions.loadSnapshot(context.analysisId, ownerRunId);
      const vinId = stableId(`${run.analysisId}:${ownerRunId}:listing-vin`);
      const vinEvidence = (pinned?.finalInput ?? pinned?.input)?.evidence.find(item => item.id === vinId);
      if (vinEvidence) evidence.push(vinEvidence);
    }
    await context.evidence.saveEvidence(
      evidence.map((item) => ({
        ...item,
        analysisId: context.analysisId,
        runId: ownerRunId,
      })),
      { analysisId: context.analysisId, runId: ownerRunId, producerStage: "enrich" },
    );
  }
}

function scopeBaselineToRun(analysisId: string, runId: string, baseline: BaselineResult): BaselineResult {
  const evidenceIds = new Map(
    baseline.evidence.map((item) => [item.id, stableId(`${analysisId}:${runId}:baseline-evidence:${item.id}`)]),
  );
  const findingIds = new Map(
    baseline.findings.map((item) => [item.id, stableId(`${analysisId}:${runId}:baseline-finding:${item.id}`)]),
  );
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
  const findingIds = new Map(
    findings.map((finding) => [finding.id, stableId(`${analysisId}:${runId}:report-finding:${finding.id}`)]),
  );
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

function confidenceInputFromRun(run: AnalysisRunContext, baseline: BaselineResult, now: Date): ConfidenceInput {
  const { snapshot } = requireOutput<CaptureOutput>(run, "capture_listing");
  const contradicted = baseline.evidence.some((evidence) => evidence.verification === "contradicted");
  const fresh =
    Date.parse(snapshot.capturedAt) <= now.getTime() + 60_000 &&
    now.getTime() - Date.parse(snapshot.capturedAt) < 7 * 24 * 60 * 60 * 1000;
  // No official identity source is checked, so identity, coverage, and agreement stay neutral.
  return {
    identity: 0.5,
    coverage: 0.5,
    agreement: contradicted ? 0 : 0.5,
    freshness: fresh ? 0.85 : 0.5,
  };
}

async function persist(context: StageContext, run: AnalysisRunContext, stageResult: StageResult): Promise<StageResult> {
  await context.analyses.saveStageResult({
    analysisId: context.analysisId,
    runId: context.runId,
    stage: context.stage,
    stageStates: run.stageStates,
    result: stageResult,
  });
  return stageResult;
}

async function finalizeAssembly(
  context: StageContext,
  stageResult: StageResult,
  report: ReturnType<typeof assembleReport>,
  now: Date,
): Promise<void> {
  await context.analyses.finalizeAssembly({
    analysisId: context.analysisId,
    runId: context.runId,
    result: stageResult,
    status: report.status,
    verdict: report.verdict,
    confidence: report.confidence,
    completedAt: now.toISOString(),
  });
}

async function captureListing(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const listingUrl = new URL(run.input.listingUrl);
  const captured =
    run.input.captureSnapshot ??
    (run.input.inputType === "pasted_text"
      ? { type: "fallback_required" as const, reason: "fetch_disabled" as const, listingUrl: listingUrl.href }
      : await context.listingAdapter.capture({ url: listingUrl }));
  const fallback = captured.type === "fallback_required";
  const buyerText =
    run.supplements
      .filter((item) => item.kind === "buyer_note" && item.providedBy === "buyer" && item.textContent)
      .at(-1)?.textContent ??
    run.input.pastedText ??
    "";
  const screenshots = run.supplements
    .filter((item) => item.kind === "screenshot" && item.providedBy === "buyer")
    .flatMap((item) => (item.storageKey ? [item.storageKey] : []));
  const initialSnapshot = fallback
    ? createFallbackSnapshot({
        originalListingUrl: listingUrl,
        pastedDescription: buyerText,
        screenshotRefs: screenshots,
      })
    : captured;
  const storedPreparation = initialSnapshot.photoPreparation;
  const retryUnavailablePhotos = storedPreparation?.images.some((image) => image.status === "unavailable");
  const photoPreparation =
    initialSnapshot.listing && context.prepareListingPhotos && (!storedPreparation || retryUnavailablePhotos)
      ? await context.prepareListingPhotos(context.analysisId, initialSnapshot.imageUrls)
      : storedPreparation;
  await context.assertLease?.();
  if (initialSnapshot.listing && context.prepareListingPhotos && photoPreparation?.counts.unavailable) {
    throw Object.assign(new Error("Selected listing photos are temporarily unavailable"), { transient: true });
  }
  const source = await context.evidence.createSourceSnapshot({
    id: stableId(`${context.analysisId}:${context.runId}:capture-source`),
    analysisId: context.analysisId,
    runId: context.runId,
    sourceType: initialSnapshot.marketplace,
    sourceUrl: initialSnapshot.sourceUrl,
    capturedAt: initialSnapshot.capturedAt,
    contentHash: initialSnapshot.contentHash,
    extractionStatus: "complete",
    producerStage: "capture_listing",
  });
  const capturedRecords =
    initialSnapshot.sourceRecords ??
    (initialSnapshot.marketplace === "fallback" && initialSnapshot.description
      ? [
          {
            evidenceId: "manual-input",
            sourceId: source.id,
            kind: "buyer_note" as const,
            content: buyerText,
            verification: "unverified" as const,
          },
        ]
      : []);
  const snapshot: ListingSnapshot = {
    ...initialSnapshot,
    ...(photoPreparation
      ? {
          photoPreparation: {
            ...photoPreparation,
            images: photoPreparation.images.map((image) => ({
              ...image,
              evidenceId: stableId(`${context.analysisId}:${context.runId}:capture-image:${image.evidenceId}`),
            })),
          },
        }
      : {}),
    ...(capturedRecords.length
      ? {
          sourceRecords: capturedRecords.map((record) => ({
            ...record,
            sourceId: source.id,
            evidenceId: stableId(`${context.analysisId}:${context.runId}:capture-record:${record.evidenceId}`),
          })),
        }
      : {}),
    sourceId: source.id,
    facts: initialSnapshot.facts.map((fact) => ({ ...fact, sourceId: source.id })),
  };
  await context.assertLease?.();
  return persist(
    context,
    run,
    completed(
      { snapshot, ownerRunId: context.runId } satisfies CaptureOutput,
      [...snapshot.warnings, ...(fallback ? [`capture_${captured.reason}`] : [])],
      now,
    ),
  );
}

async function normalizeIdentity(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run);
  const vehicle = normalizeVehicle(snapshot);
  await context.evidence.saveVehicleFacts(
    snapshot.facts.map((fact) => ({
      ...fact,
      id: stableId(`${context.analysisId}:${context.runId}:fact:${fact.key}:${fact.sourceId}`),
      analysisId: context.analysisId,
      runId: context.runId,
    })),
    { analysisId: context.analysisId, runId: context.runId },
  );
  return persist(context, run, completed({ vehicle } satisfies NormalizeOutput, [], now));
}

async function baselineChecks(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run, true);
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const baseline = scopeBaselineToRun(
    context.analysisId,
    context.runId,
    runBaselineChecks(vehicle, snapshot, run.locale),
  );
  // Capture citations and each supplied listing image become canonical owned evidence.
  baseline.evidence.push(
    ...(snapshot.sourceRecords ?? []).map((record) => ({
      id: record.evidenceId,
      sourceId: record.sourceId,
      sourceClass: record.kind === "buyer_note" ? ("buyer" as const) : ("listing" as const),
      sourceUrl: snapshot.sourceUrl,
      claim: (typeof record.content === "string" ? record.content : JSON.stringify(record.content)).slice(0, 4000),
      applicability: "Unverified captured listing content.",
      confidence: 0.5,
      verification: "unverified" as const,
      capturedAt: snapshot.capturedAt,
    })),
    ...(snapshot.photoPreparation?.images ?? []).map((image) => ({
      id: image.evidenceId,
      sourceId: snapshot.sourceId,
      sourceClass: "listing" as const,
      sourceUrl: snapshot.sourceUrl,
      claim: `Supplied listing image ${image.index + 1}; ${image.status}.`,
      applicability: "Unverified listing image; interpretation does not confirm physical condition.",
      confidence: 0.5,
      verification: "unverified" as const,
      capturedAt: snapshot.capturedAt,
    })),
  );
  const supplements = supplementEvidence(run, now);
  baseline.evidence.push(...supplements);
  const supplementIds = new Set(supplements.map((item) => item.id));
  await context.evidence.saveEvidence(
    baseline.evidence
      .filter((item) => !supplementIds.has(item.id))
      .map((item) => ({
        ...item,
        analysisId: context.analysisId,
        runId: run.runId,
      })),
    { analysisId: context.analysisId, runId: run.runId, producerStage: "baseline_checks" },
  );
  await persistSupplementEvidence(context, run, supplements);
  return persist(context, run, completed({ ...baseline, captureCitationRunId: run.runId }, [], now));
}

async function research(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const officialLinks = officialLinksFor(vehicle);
  const sourceInputs: SourceSnapshotInput[] = [
    {
      id: stableId(`${context.analysisId}:${context.runId}:research:transport-administration`),
      analysisId: context.analysisId,
      runId: context.runId,
      sourceType: "transportAdministration",
      sourceUrl: officialLinks.transportAdministration.url,
      extractionStatus: "unavailable" as const,
      metadata: {
        report_key: "transportAdministration",
        report_label: officialLinks.transportAdministration.label,
      },
    },
  ];
  const sourceStates: Record<string, SourceSummary> = {
    transportAdministration: {
      verification: "not_checked",
      label: officialLinks.transportAdministration.label,
      url: officialLinks.transportAdministration.url,
    },
  };
  if (officialLinks.manufacturer) {
    sourceInputs.push({
      id: stableId(`${context.analysisId}:${context.runId}:research:manufacturer`),
      analysisId: context.analysisId,
      runId: context.runId,
      sourceType: "manufacturer",
      sourceUrl: officialLinks.manufacturer.url,
      extractionStatus: "unavailable" as const,
    });
    sourceStates.manufacturer = {
      verification: officialLinks.manufacturer.verification,
      label: officialLinks.manufacturer.label,
      url: officialLinks.manufacturer.url,
    };
  }
  await context.evidence.saveSourceSnapshots(sourceInputs, "research");
  return persist(context, run, unavailable({ sourceStates } satisfies ResearchOutput, ["research_unavailable"], now));
}

async function enrich(context: StageContext, run: AnalysisRunContext, now: Date): Promise<StageResult> {
  const snapshot = snapshotWithSupplements(run);
  const { vehicle } = requireOutput<NormalizeOutput>(run, "normalize_identity");
  const inheritedBaseline = requireOutput<BaselineResult>(run, "baseline_checks");
  const existingEvidenceIds = new Set(inheritedBaseline.evidence.map((item) => item.id));
  const admittedSupplementEvidence = supplementEvidence(run, now);
  const currentSupplementEvidence = admittedSupplementEvidence.filter((item) => !existingEvidenceIds.has(item.id));
  const baseline: BaselineResult = {
    ...inheritedBaseline,
    evidence: [...inheritedBaseline.evidence, ...currentSupplementEvidence],
  };
  return durableEnrich(context, run, now, snapshot, vehicle, baseline);
}

async function durableEnrich(
  context: StageContext,
  run: AnalysisRunContext,
  now: Date,
  snapshot: ListingSnapshot,
  vehicle: NormalizedVehicle,
  baseline: BaselineResult,
): Promise<StageResult> {
  const repository = context.reviewExecutions;
  if (!repository || !context.jobId || !context.workerId) throw new Error("Review requires the owned enrich job");
  const lease = {
    analysisId: context.analysisId,
    runId: context.runId,
    jobId: context.jobId,
    workerId: context.workerId,
  };
  const background = await loadReconciledBackground(context);
  const officialEvidence = officialBackgroundEvidence(run, background, now);
  const officialLabel = officialEvidence?.claim;
  const listingEvidence = listingVinEvidence(run, vehicle, snapshot);
  const outcome = await reviewRun({
    lease,
    run,
    listing: snapshot,
    vehicle,
    baseline,
    official: officialEvidence ? { evidence: officialEvidence, content: `${officialLabel}\n${background?.text_content ?? ""}`, sha256: background?.sha256 ?? null } : undefined,
    beforePin: async () => {
      if (listingEvidence) baseline.evidence.push(listingEvidence);
      await persistSupplementEvidence(context, run, supplementEvidence(run, now), listingEvidence ? [listingEvidence] : []);
    },
    backgroundCheck: context.getBackgroundCheck ? () => context.getBackgroundCheck!(context.analysisId) : undefined,
    now: context.now,
    repository,
    reviewConfig: () => (context.dataReviewer ? resolveReviewConfig : resolveProductionReviewConfig)(context.insightEnvironment ?? {}),
    assertLease: context.assertLease,
    reviewer:
      context.dataReviewer ??
      ((pin) => ({review: async (input, options) => {
        // Existing immutable snapshots may predate the image cost ceiling.
        // Retain their audit identity and require a fresh run rather than making a heavier call.
        if (input.pass === "image" && !isProductionImageSettingsAllowed(pin)) {
          return {schemaVersion:1,observations:[],warnings:[{code:"unavailable",message:"Image review settings exceed the configured limit. Start a fresh review."}]};
        }
        return createDataReviewer(pin, context.insightEnvironment ?? {}, context.insightImageBoundary).review(input, options);
      }})),
    imageCapability: (id, key, hash) =>
      context.reviewImageCapability
        ? context.reviewImageCapability(context.analysisId, id, key, hash)
        : Promise.reject(new Error("image_unavailable")),
    progress: async (review) => {
      await context.assertLease?.();
      await repository.saveProgress(
        lease,
        unavailable(
          { evidence: [], findings: [], actions: [], review } satisfies EnrichOutput,
          [review.state === "incomplete" ? "enrich_unavailable" : "enrich_pending"],
          now,
        ),
      );
    },
    publication: (observations, review, pinnedSnapshot) => {
      const deterministic = officialPdfFindings(pinnedSnapshot);
      const pairs = observations.map((observation) => {
        const findingId = stableId(`${run.analysisId}:${run.runId}:review:${observation.id}`);
        return {
          finding: {
            id: findingId,
            category: observation.category,
            severity: observation.severity,
            state: "open" as const,
            title: observation.title,
            explanation: observation.explanation,
            nextAction: observation.recommendedAction.instructions,
            evidenceIds: observation.evidenceIds,
            origin: "agent" as const,
          },
          action: {
            id: stableId(`${findingId}:action`),
            ...observation.recommendedAction,
            instructions: observation.recommendedAction.instructions,
            status: "open" as const,
            findingId,
          },
        };
      });
      const report = assembleReport({
        publicId: run.publicId,
        locale: run.locale,
        status: "complete",
        review,
        evidence: [...(pinnedSnapshot.finalInput ?? pinnedSnapshot.input).evidence],
        findings: [...baseline.findings, ...deterministic.findings, ...pairs.map((pair) => pair.finding)],
        actions: [...baseline.actions, ...deterministic.actions, ...pairs.map((pair) => pair.action)],
        sourceStates: { transportAdministration: "not_checked" },
        warnings: [],
        confidenceInput: confidenceInputFromRun(run, baseline, now),
        updatedAt: now.toISOString(),
      });
      const scoped = scopeReportRecordsToRun(context.analysisId, context.runId, report.findings, report.actions);
      return {
        assemblyResult: completed(
          { status: "complete", advanceToResearch: false, evidenceIds: report.evidence.map((item) => item.id), review },
          [],
          now,
        ),
        status: "complete",
        verdict: report.verdict,
        confidence: report.confidence,
        completedAt: now.toISOString(),
        findings: scoped.findings.map((finding) => ({
          id: finding.id,
          analysis_id: run.analysisId,
          run_id: run.runId,
          category: finding.category,
          severity: finding.severity,
          state: finding.state,
          title: finding.title,
          explanation: finding.explanation,
          next_action: finding.nextAction,
          origin: finding.origin ?? "deterministic",
          evidence_links: finding.evidenceIds.map((id) => ({ evidence_id: id, relation: "supports" })),
        })),
        actions: scoped.actions.map((action) => ({
          id: action.id,
          analysis_id: run.analysisId,
          run_id: run.runId,
          kind: action.kind,
          title: action.title,
          instructions: action.instructions,
          status: action.status,
          finding_id: action.findingId ?? null,
        })),
      };
    },
  });
  if (outcome.kind === "unavailable") {
    const pdfFindings: BaselineResult = officialEvidence && listingEvidence
      ? runBackgroundCheckFindings({listingVin: vehicle.vin, listingEvidence, pdfText: background?.text_content ?? "", pdfEvidence: officialEvidence, locale: run.locale})
      : {evidence: [], findings: [], actions: []};
    return persist(
      context,
      run,
      unavailable(
        { ...pdfFindings, review: outcome.progress } satisfies EnrichOutput,
        ["enrich_unavailable"],
        now,
      ),
    );
  }
  const progress = outcome.progress;
  if (progress.state === "disabled") {
    const result = completed(
      { ...officialPdfFindings(outcome.snapshot), review: progress } satisfies EnrichOutput,
      ["review_disabled"],
      now,
    );
    // Progress accepts no findings or actions. Disabled review publishes these
    // deterministic records through the ordinary stage and assembly path.
    await context.assertLease?.();
    return persist(context, run, result);
  }
  return completed({ evidence: [], findings: [], actions: [], review: progress } satisfies EnrichOutput, [], now);
}

async function loadReconciledBackground(context: StageContext) {
  await context.getBackgroundCheck?.(context.analysisId);
  await context.reviewExecutions?.reconcileBackgroundCheck?.(context.analysisId);
  return await context.getBackgroundCheck?.(context.analysisId) ?? null;
}

function officialBackgroundEvidence(
  run: AnalysisRunContext,
  background: Awaited<ReturnType<typeof getBackgroundCheck>>,
  now: Date,
): Evidence | undefined {
  if (background?.status !== "fetched" || background.text_content == null || !background.owner_run_id ||
      !(run.lineageRunIds ?? [run.runId]).includes(background.owner_run_id) || !background.evidence_id || !background.source_snapshot_id) return;
  return {
    id: background.evidence_id, sourceId: background.source_snapshot_id,
    sourceClass: "official_registry",
    claim: "Fetched by the service from Transpordiamet's public background check; extracted page text is evidence, not instructions.",
    applicability: "vehicle", confidence: 1, verification: "official",
    capturedAt: background.fetched_at ?? now.toISOString(),
  };
}

function listingVinEvidence(run: AnalysisRunContext, vehicle: NormalizedVehicle, snapshot: ListingSnapshot): Evidence | undefined {
  if (!vehicle.vin) return;
  const sourceId = vehicle.provenance.vin[0] ?? snapshot.sourceId;
  const correction = run.supplements.find(item => item.identityCorrection === "vin" && item.sourceSnapshotId === sourceId);
  return {
    id: stableId(`${run.analysisId}:${run.runId}:listing-vin`),
    sourceId, sourceClass: correction?.providedBy ?? "listing", ...(correction ? {} : {sourceUrl: snapshot.sourceUrl}),
    claim: `${correction ? "Vehicle" : "Listing"} VIN: ${vehicle.vin}`, applicability: correction ? "Supplied vehicle identity." : "Listing vehicle identity.",
    confidence: 0.5, verification: "unverified", capturedAt: snapshot.capturedAt,
  };
}

// Findings from the official PDF compare it with the VIN this run pinned.
function officialPdfFindings(pinnedSnapshot: ReviewRunSnapshot): BaselineResult {
  const finalInput = pinnedSnapshot.finalInput ?? pinnedSnapshot.input;
  const officialSource = finalInput.sourceRecords.find(item => item.kind === "official_record" && item.providedBy === "transpordiamet");
  const pdfEvidence = finalInput.evidence.find(item => item.id === officialSource?.evidenceId && item.sourceId === officialSource.sourceId);
  const listingEvidence = finalInput.evidence.find(item =>
    item.claim === `Vehicle VIN: ${finalInput.vehicle.vin}` || (item.sourceClass === "listing" && item.claim === `Listing VIN: ${finalInput.vehicle.vin}`),
  );
  return pdfEvidence && listingEvidence && typeof officialSource?.content === "string"
    ? runBackgroundCheckFindings({listingVin: finalInput.vehicle.vin, listingEvidence, pdfText: officialSource.content, pdfEvidence, locale: pinnedSnapshot.locale})
    : {evidence: pdfEvidence ? [pdfEvidence] : [], findings: [], actions: []};
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
    const stageResult = unavailable(
      {
        status: report.status,
        advanceToResearch: false,
        evidenceIds: [],
      } satisfies AssemblyOutput,
      report.warnings,
      now,
    );
    await finalizeAssembly(context, stageResult, report, now);
    return stageResult;
  }
  const researchState = stateFor<ResearchOutput>(run, "research");
  const enrichState = stateFor<EnrichOutput>(run, "enrich");
  const warnings = [
    ...baselineState.warnings,
    ...(researchState ? researchState.warnings : ["research_pending"]),
    ...(enrichState ? enrichState.warnings : ["enrich_pending"]),
  ];
  let reviewRecords: BaselineResult = { evidence: [], findings: [], actions: [] };
  let isComplete =
    isTerminalEnrichment(researchState) &&
    (enrichState?.output.review
      ? ["complete", "disabled"].includes(enrichState.output.review.state)
      : isTerminalEnrichment(enrichState));
  if (context.reviewExecutions) {
    const pinned = await context.reviewExecutions.loadSnapshot(context.analysisId, context.runId);
    if (pinned?.mode !== "disabled") {
      if (pinned) {
        const executions = await context.reviewExecutions.loadExecutions(context.analysisId, context.runId);
        const finalCommitted = executions.some(
          (execution) => execution.pass === "final" && execution.result && execution.resultHash,
        );
        if (finalCommitted)
          return completed(
            {
              status: "complete",
              advanceToResearch: false,
              evidenceIds: (pinned.finalInput ?? pinned.input).evidence.map((item) => item.id),
            } satisfies AssemblyOutput,
            [],
            now,
          );
        isComplete = false;
        reviewRecords = officialPdfFindings(pinned);
      }
      if (!pinned) {
        const background = await loadReconciledBackground(context);
        const pdfEvidence = officialBackgroundEvidence(run, background, now);
        if (pdfEvidence) {
          const {vehicle} = requireOutput<NormalizeOutput>(run, "normalize_identity");
          const listingEvidence = listingVinEvidence(run, vehicle, snapshotWithSupplements(run));
          if (listingEvidence) {
            reviewRecords = runBackgroundCheckFindings({listingVin: vehicle.vin, listingEvidence, pdfText: background!.text_content!, pdfEvidence, locale: run.locale});
            await persistSupplementEvidence(context, run, supplementEvidence(run, now), [listingEvidence]);
          }
        }
      }
      if (run.reviewReuseRunId) {
        isComplete = false;
        let inherited = false;
        const citedIds = new Set<string>();
        for (const id of await context.reviewExecutions.loadReuseRunIds(context.analysisId, run.runId)) {
          if (!inherited) {
            const published = await context.analyses.loadAgentRecords(context.analysisId, id);
            if (!published.findings.length) {
              const executions = await context.reviewExecutions.loadExecutions(context.analysisId, id);
              if (executions.some(execution => execution.pass === "final" && execution.result && execution.resultHash)) break;
              continue;
            }
            inherited = true;
            reviewRecords.findings.push(...published.findings);
            reviewRecords.actions.push(...published.actions);
            for (const finding of published.findings) for (const evidenceId of finding.evidenceIds) citedIds.add(evidenceId);
          }
          const reused = await context.reviewExecutions.loadSnapshot(context.analysisId, id);
          for (const item of (reused?.finalInput ?? reused?.input)?.evidence ?? []) {
            if (citedIds.delete(item.id)) reviewRecords.evidence.push(item);
          }
          if (!citedIds.size) break;
        }
      }
    }
  }
  const reportEvidence = [
    ...new Map(
      [
        ...baselineState.output.evidence,
        ...(enrichState?.output.evidence ?? []),
        ...reviewRecords.evidence,
      ].map((item) => [item.id, item]),
    ).values(),
  ];
  const report = assembleReport({
    publicId: run.publicId,
    locale: run.locale,
    ...(enrichState?.output.review ? { review: enrichState.output.review } : {}),
    status: isComplete ? "complete" : "partial",
    vehicleFacts: [],
    evidence: reportEvidence,
    findings: [...new Map([...baselineState.output.findings, ...(enrichState?.output.findings ?? []), ...reviewRecords.findings].map(item => [item.id, item])).values()],
    actions: [...baselineState.output.actions, ...(enrichState?.output.actions ?? []), ...reviewRecords.actions],
    sourceStates: {
      transportAdministration: researchState?.output.sourceStates.transportAdministration ?? "not_checked",
      ...(researchState?.output.sourceStates ?? {}),
    },
    warnings,
    confidenceInput: confidenceInputFromRun(run, baselineState.output, now),
    updatedAt: now.toISOString(),
  });
  const { findings: findingsToPersist, actions: actionsToPersist } = scopeReportRecordsToRun(
    context.analysisId,
    context.runId,
    report.findings,
    report.actions,
  );
  const findingIds = await context.evidence.saveFindings(
    findingsToPersist.map((finding) => ({
      ...finding,
      analysisId: context.analysisId,
      runId: context.runId,
      evidenceLinks: finding.evidenceIds
        .filter((evidenceId) => report.evidence.some((evidence) => evidence.id === evidenceId))
        .map((evidenceId) => ({ evidenceId, relation: "supports" as const })),
    })),
    { analysisId: context.analysisId, runId: context.runId },
  );
  const persistedFindingIds = new Map(
    findingsToPersist.map((finding, index) => [finding.id, findingIds[index] ?? ""]),
  );
  await context.evidence.saveActions(
    actionsToPersist.flatMap((action) => {
      const findingId = action.findingId ? persistedFindingIds.get(action.findingId) : undefined;
      if (action.findingId && !findingId) return [];
      return [
        {
          ...action,
          ...(findingId ? { findingId } : {}),
          analysisId: context.analysisId,
          runId: context.runId,
        },
      ];
    }),
    { analysisId: context.analysisId, runId: context.runId },
  );
  const stageResult = completed(
    {
      status: report.status,
      advanceToResearch: !researchState,
      evidenceIds: report.evidence.map((item) => item.id),
    } satisfies AssemblyOutput,
    report.warnings,
    now,
  );
  await finalizeAssembly(context, stageResult, report, now);
  return stageResult;
}

export async function runStage(context: StageContext): Promise<StageResult> {
  const run = await context.analyses.loadRunContext(context.analysisId, context.runId, {
    hydrateImageCapabilities: context.stage === "enrich",
  });
  const now = context.now?.() ?? new Date();
  const existing = run.stageStates[context.stage];
  const partialAssembly =
    context.stage === "assemble_report" &&
    (existing?.output as Partial<AssemblyOutput> | undefined)?.advanceToResearch === true;
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
): Record<
  AnalysisStage,
  (job: AnalysisJob, assertLease?: () => void | Promise<void>) => Promise<void | StageExecutionResult>
> {
  return Object.fromEntries(
    (
      ["capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"] as const
    ).map((stage) => [
      stage,
      async (job: AnalysisJob, assertLease?: () => void | Promise<void>) => {
        const execute = () => runStage({
          ...context,
          analysisId: job.analysisId,
          runId: job.runId,
          jobId: job.id,
          stage,
          assertLease,
        });
        let result: StageResult;
        try {
          result = context.photoTimings?.enabled && (stage === "capture_listing" || stage === "enrich")
            ? await runPhotoTimingJob(new PhotoTimingRecorder({
                enabled: true, write: (rows, signal) => context.photoTimings!.write(job, rows, signal),
                evidenceId: stage === "capture_listing" ? id => stableId(`${job.analysisId}:${job.runId}:capture-image:${id}`) : undefined,
              }), execute)
            : await execute();
        } catch (error) {
          if (error instanceof ReviewDeferredError) return { deferUntil: error.deferUntil };
          throw error;
        }
        if (stage !== "assemble_report") return;
        return {
          enqueueDependents: (result.output as Partial<AssemblyOutput>).advanceToResearch === true,
        };
      },
    ]),
  ) as Record<
    AnalysisStage,
    (job: AnalysisJob, assertLease?: () => void | Promise<void>) => Promise<void | StageExecutionResult>
  >;
}
