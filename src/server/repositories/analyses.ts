import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Action,
  AnalysisReport,
  AnalysisStatus,
  ConfidenceBand,
  Evidence,
  Finding,
  Locale,
  SourceSummary,
  VehicleFact,
  Verdict,
  VerificationState,
} from "@/domain/analysis";
import type { AnalysisStage } from "@/analysis/stages";
import { createHash } from "node:crypto";
import { AnalysisUploads } from "@/server/storage/uploads";
import { issueInsightImageCapability } from "@/insights/image-capability";

export interface CreateAnalysisInput {
  accessTokenHash: string;
  locale: Locale;
  listingUrl: string;
  inputType?: "url" | "pasted_text" | "url_with_fallback";
  pastedText?: string;
  vin?: string;
  registrationPlate?: string;
}

interface AnalysisRow {
  id: string;
  public_id: string;
  current_run_id: string | null;
  status: AnalysisStatus;
  locale: Locale;
  verdict: Verdict | null;
  confidence: ConfidenceBand | null;
  updated_at: string;
}

export interface VersionedStageResult<T = unknown> {
  version: 1;
  status: "complete" | "unavailable";
  output: T;
  warnings: string[];
  completedAt: string;
}

export interface AnalysisRunContext {
  analysisId: string;
  publicId: string;
  runId: string;
  locale: Locale;
  input: {
    listingUrl: string;
    inputType: "url" | "pasted_text" | "url_with_fallback";
    pastedText?: string;
    vin?: string;
    registrationPlate?: string;
  };
  supplements: AnalysisSupplement[];
  stageStates: Partial<Record<AnalysisStage, VersionedStageResult>>;
}

export interface AnalysisSupplement {
  id: string;
  acceptedRunId?: string;
  createdAt?: string;
  kind: "seller_answer" | "buyer_note" | "image" | "screenshot" | "document";
  providedBy: "seller" | "buyer";
  textContent?: string;
  storageKey?: string;
  mimeType?: string;
  identityCorrection?: "vin" | "registrationPlate";
  sourceSnapshotId: string;
  signedImage?: unknown;
  imageCapabilityWarning?: string;
}

function requireData<T>(data: T | null, error: unknown, operation: string): T {
  if (error) throw new Error(operation, { cause: error });
  if (data === null) throw new Error(`${operation}: no data returned`);
  return data;
}

function warningsForRun(failure: unknown, stageStates: unknown): string[] {
  const warnings = failure ? ["analysis_run_unavailable"] : [];
  if (!stageStates || typeof stageStates !== "object" || Array.isArray(stageStates)) return warnings;
  for (const stage of Object.values(stageStates as Record<string, unknown>)) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) continue;
    const stageWarnings = (stage as { warnings?: unknown }).warnings;
    if (!Array.isArray(stageWarnings)) continue;
    for (const warning of stageWarnings) {
      if (typeof warning === "string" && /^[a-z_]+$/.test(warning)) warnings.push(warning);
    }
  }
  return [...new Set(warnings)];
}

function sourceVerification(
  snapshotId: string,
  extractionStatus: string,
  evidenceRows: Array<{ source_snapshot_id: string; verification: VerificationState }>,
): VerificationState {
  if (extractionStatus !== "complete") return "not_checked";

  const rank: Record<VerificationState, number> = {
    not_checked: 0,
    unverified: 1,
    contradicted: 2,
    corroborated: 3,
    official: 4,
  };
  return evidenceRows
    .filter((row) => row.source_snapshot_id === snapshotId)
    .reduce<VerificationState>(
      (current, row) => (rank[row.verification] > rank[current] ? row.verification : current),
      "unverified",
    );
}

function stableId(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class AnalysesRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly imageCapabilitySecret = process.env.ANALYSIS_COOKIE_SECRET,
  ) {}

  async create(input: CreateAnalysisInput): Promise<{ publicId: string }> {
    const { data, error } = await this.client.rpc("create_analysis", {
      p_access_token_hash: input.accessTokenHash,
      p_locale: input.locale,
      p_listing_url: input.listingUrl,
      p_input_type: input.inputType ?? "url",
      p_pasted_text: input.pastedText ?? null,
      p_vin: input.vin ?? null,
      p_registration_plate: input.registrationPlate ?? null,
    });
    if (error) throw new Error("Could not create analysis", { cause: error });
    const created = (data as Array<{ public_id: string }> | null)?.[0];
    if (!created) throw new Error("Could not create analysis: no data returned");
    return { publicId: created.public_id };
  }

  async loadAccessTokenHash(publicId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("analyses")
      .select("access_token_hash")
      .eq("public_id", publicId)
      .maybeSingle();
    if (error) throw new Error("Could not load analysis access", { cause: error });
    if (!data) return null;
    return data.access_token_hash as string;
  }

  async loadAnalysisId(publicId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("analyses")
      .select("id")
      .eq("public_id", publicId)
      .maybeSingle();
    if (error) throw new Error("Could not load analysis", { cause: error });
    return data ? data.id as string : null;
  }

  async loadReport(publicId: string): Promise<AnalysisReport | null> {
    const analysisResult = await this.client
      .from("analyses")
      .select("id, public_id, current_run_id, status, locale, verdict, confidence, updated_at")
      .eq("public_id", publicId)
      .maybeSingle();
    if (analysisResult.error) {
      throw new Error("Could not load analysis", { cause: analysisResult.error });
    }
    if (!analysisResult.data) return null;

    const analysis = analysisResult.data as AnalysisRow;
    if (!analysis.current_run_id) return this.emptyReport(analysis);
    const runId = analysis.current_run_id;
    const runIds = await this.loadRunLineage(analysis.id, runId);

    const [factsResult, snapshotsResult, evidenceResult, findingsResult, actionsResult, runResult, lineageRunsResult] =
      await Promise.all([
        this.client.from("vehicle_facts").select("*").eq("analysis_id", analysis.id).in("run_id", runIds),
        this.client.from("source_snapshots").select("*").eq("analysis_id", analysis.id).in("run_id", runIds),
        this.client.from("evidence").select("*").eq("analysis_id", analysis.id).in("run_id", runIds),
        this.client.from("findings").select("*").eq("analysis_id", analysis.id).in("run_id", runIds),
        this.client.from("actions").select("*").eq("analysis_id", analysis.id).in("run_id", runIds),
        this.client.from("analysis_runs").select("failure, stage_states").eq("id", runId).single(),
        this.client.from("analysis_runs").select("id, stage_states").eq("analysis_id", analysis.id).in("id", runIds),
      ]);

    const allFacts = requireData(factsResult.data, factsResult.error, "Could not load vehicle facts") as Array<Record<string, unknown>>;
    const snapshots = requireData(snapshotsResult.data, snapshotsResult.error, "Could not load source snapshots") as Array<Record<string, unknown>>;
    const allEvidenceRows = requireData(evidenceResult.data, evidenceResult.error, "Could not load evidence") as Array<Record<string, unknown>>;
    const allFindingRows = requireData(findingsResult.data, findingsResult.error, "Could not load findings") as Array<Record<string, unknown>>;
    const allActionRows = requireData(actionsResult.data, actionsResult.error, "Could not load actions") as Array<Record<string, unknown>>;
    const run = requireData(runResult.data, runResult.error, "Could not load analysis run") as {
      failure: unknown;
      stage_states: unknown;
    };
    const lineageRuns = requireData(lineageRunsResult.data, lineageRunsResult.error, "Could not load analysis run lineage") as Array<{
      id: string;
      stage_states: unknown;
    }>;
    const stageStatesFor = (candidate: string): Record<string, {
      version?: unknown;
      status?: unknown;
      output?: { evidence?: Array<{ id?: unknown }>; evidenceIds?: unknown };
    }> => (lineageRuns.find((lineageRun) => lineageRun.id === candidate)?.stage_states ?? {}) as Record<string, {
      version?: unknown;
      status?: unknown;
      output?: { evidence?: Array<{ id?: unknown }>; evidenceIds?: unknown };
    }>;
    const isTerminalAssembly = (stageStates: ReturnType<typeof stageStatesFor>): boolean => {
      const assembly = stageStates.assemble_report;
      return assembly?.version === 1 && (assembly.status === "complete" || assembly.status === "unavailable");
    };
    const assembledRunId = runIds.find((candidate) => isTerminalAssembly(stageStatesFor(candidate)));
    const stageOutputs = assembledRunId ? stageStatesFor(assembledRunId) : {};
    const nearestArtifactRun = (rows: Array<Record<string, unknown>>): string | undefined =>
      runIds.find((candidate) => rows.some((row) => row.run_id === candidate));
    const factRunId = nearestArtifactRun(allFacts);
    const facts = factRunId ? allFacts.filter((row) => row.run_id === factRunId) : [];
    const findingRows = assembledRunId ? allFindingRows.filter((row) => row.run_id === assembledRunId) : [];
    const actionRows = assembledRunId ? allActionRows.filter((row) => row.run_id === assembledRunId) : [];
    const assemblyOutput = stageOutputs.assemble_report?.output;
    const hasAssemblyEvidenceIds = Boolean(assemblyOutput
      && Object.prototype.hasOwnProperty.call(assemblyOutput, "evidenceIds"));
    const assembledEvidenceIds = new Set(Array.isArray(assemblyOutput?.evidenceIds)
      ? assemblyOutput.evidenceIds.filter((id): id is string => typeof id === "string")
      : []);
    const baselineOutput = stageOutputs
      ?.baseline_checks?.output;
    const baselineEvidenceIds = new Set(
      (baselineOutput?.evidence ?? []).flatMap((item) => typeof item.id === "string" ? [item.id] : []),
    );
    const fallbackEvidenceRunId = nearestArtifactRun(allEvidenceRows);
    const evidenceRows = hasAssemblyEvidenceIds
      ? allEvidenceRows.filter((row) => assembledEvidenceIds.has(row.id as string))
      : baselineEvidenceIds.size > 0
        ? allEvidenceRows.filter((row) => baselineEvidenceIds.has(row.id as string))
        : fallbackEvidenceRunId
          ? allEvidenceRows.filter((row) => row.run_id === fallbackEvidenceRunId)
          : [];

    const findingIds = findingRows.map((row) => row.id as string);
    const linkRows = findingIds.length
      ? requireData(
          ...await this.findingEvidence(findingIds),
          "Could not load finding evidence",
        ) as Array<{ finding_id: string; evidence_id: string }>
      : [];

    const evidenceForSources = evidenceRows as unknown as Array<{
      source_snapshot_id: string;
      verification: VerificationState;
    }>;
    const researchRunId = runIds.find((candidate) => {
      const research = stageStatesFor(candidate).research;
      return research?.version === 1 && (research.status === "complete" || research.status === "unavailable");
    });
    const sourceIds = new Set(evidenceRows.map((row) => row.source_snapshot_id as string));
    const sourceRows = snapshots.filter((row) => (
      !assembledRunId
      || sourceIds.has(row.id as string)
      || (row.run_id === researchRunId && (row.source_type === "transportAdministration" || row.source_type === "manufacturer"))
    )).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const sources: Record<string, SourceSummary> = {};
    for (const row of sourceRows) {
        const id = row.id as string;
        const isTransportAdministration = row.source_type === "transportAdministration";
        const isManufacturer = row.source_type === "manufacturer";
        const reportKey = isTransportAdministration || isManufacturer ? row.source_type as string : id;
        if (sources[reportKey]) continue;
        const summary: SourceSummary = {
          verification: sourceVerification(
            id,
            row.extraction_status as string,
            evidenceForSources,
          ),
        };
        if (typeof row.source_url === "string") summary.url = row.source_url;
        if (isTransportAdministration) {
          summary.label = "Estonian Transport Administration vehicle background check";
        }
        if (isManufacturer) summary.label = "Manufacturer recall information";
        sources[reportKey] = summary;
    }

    return {
      publicId: analysis.public_id,
      status: analysis.status,
      locale: analysis.locale,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      vehicleFacts: facts.map((row): VehicleFact => ({
        key: row.fact_key as string,
        value: row.fact_value as string,
        ...(typeof row.normalized_value === "string" ? { normalizedValue: row.normalized_value } : {}),
        sourceId: row.source_snapshot_id as string,
        verification: row.verification as VehicleFact["verification"],
        confidence: row.match_confidence as number,
      })),
      evidence: evidenceRows.map((row): Evidence => {
        const sourceUrl = sources[row.source_snapshot_id as string]?.url;
        return {
          id: row.id as string,
          sourceId: row.source_snapshot_id as string,
          sourceClass: row.source_class as Evidence["sourceClass"],
          ...(sourceUrl ? { sourceUrl } : {}),
          claim: row.claim as string,
          applicability: row.applicability as string,
          confidence: row.confidence as number,
          verification: row.verification as Evidence["verification"],
          capturedAt: row.captured_at as string,
        };
      }),
      findings: findingRows.map((row): Finding => ({
        id: row.id as string,
        category: row.category as string,
        severity: row.severity as Finding["severity"],
        state: row.state as Finding["state"],
        title: row.title as string,
        explanation: row.explanation as string,
        nextAction: row.next_action as string,
        evidenceIds: linkRows.filter((link) => link.finding_id === row.id).map((link) => link.evidence_id),
        origin: row.origin as Finding["origin"],
      })),
      actions: actionRows.map((row): Action => ({
        id: row.id as string,
        kind: row.kind as Action["kind"],
        title: row.title as string,
        instructions: row.instructions as string,
        status: row.status as Action["status"],
        ...(typeof row.finding_id === "string" ? { findingId: row.finding_id } : {}),
      })),
      sources,
      warnings: warningsForRun(run.failure, run.stage_states),
      updatedAt: analysis.updated_at,
    };
  }

  async loadRunContext(
    analysisId: string,
    runId: string,
    options: { hydrateImageCapabilities?: boolean } = {},
  ): Promise<AnalysisRunContext> {
    const [analysisResult, runResult, inputResult] = await Promise.all([
      this.client
        .from("analyses")
        .select("id, public_id, locale")
        .eq("id", analysisId)
        .maybeSingle(),
      this.client
        .from("analysis_runs")
        .select("id, stage_states")
        .eq("id", runId)
        .eq("analysis_id", analysisId)
        .maybeSingle(),
      this.client
        .from("analysis_inputs")
        .select("listing_url, input_type, pasted_text, vin, registration_plate")
        .eq("analysis_id", analysisId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const analysis = requireData(analysisResult.data, analysisResult.error, "Could not load analysis run");
    const run = requireData(runResult.data, runResult.error, "Could not load analysis run");
    const input = requireData(inputResult.data, inputResult.error, "Could not load analysis input");
    const runIds = await this.loadRunLineage(analysisId, runId);
    const submissionsResult = await this.client
      .from("submissions")
      .select("id, kind, provided_by, text_content, storage_key, mime_type, source_snapshot_id, metadata, created_at")
      .eq("analysis_id", analysisId)
      .in("run_id", runIds)
      .order("created_at", { ascending: true });
    const submissionRows = requireData(
      submissionsResult.data,
      submissionsResult.error,
      "Could not load analysis supplements",
    ) as Array<Record<string, unknown>>;
    const uploads = new AnalysisUploads(this.client);
    const supplements = await Promise.all(submissionRows.map(async (row): Promise<AnalysisSupplement> => {
      const supplement: AnalysisSupplement = {
        id: row.id as string,
        acceptedRunId: row.run_id as string,
        kind: row.kind as AnalysisSupplement["kind"],
        providedBy: row.provided_by as AnalysisSupplement["providedBy"],
        sourceSnapshotId: row.source_snapshot_id as string,
      };
      if (typeof row.created_at === "string") supplement.createdAt = row.created_at;
      if (typeof row.text_content === "string") supplement.textContent = row.text_content;
      if (typeof row.storage_key === "string") supplement.storageKey = row.storage_key;
      if (typeof row.mime_type === "string") supplement.mimeType = row.mime_type;
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
      if (metadata.identity_correction === "vin" || metadata.identity_correction === "registrationPlate") {
        supplement.identityCorrection = metadata.identity_correction;
      }
      if (options.hydrateImageCapabilities && supplement.kind === "image" && supplement.storageKey && this.imageCapabilitySecret) {
        try {
          const signed = await uploads.createSignedRead(analysisId, supplement.storageKey);
          supplement.signedImage = issueInsightImageCapability({
            evidenceId: stableId(`${analysisId}:${supplement.acceptedRunId ?? runId}:supplement:${supplement.id}`),
            analysisId,
            storageKey: supplement.storageKey,
            ...signed,
          }, this.imageCapabilitySecret);
        } catch {
          supplement.imageCapabilityWarning = "image_signing_unavailable";
        }
      }
      return supplement;
    }));

    return {
      analysisId: analysis.id as string,
      publicId: analysis.public_id as string,
      runId: run.id as string,
      locale: analysis.locale as Locale,
      input: {
        listingUrl: input.listing_url as string,
        inputType: input.input_type as AnalysisRunContext["input"]["inputType"],
        ...(typeof input.pasted_text === "string" ? { pastedText: input.pasted_text } : {}),
        ...(typeof input.vin === "string" ? { vin: input.vin } : {}),
        ...(typeof input.registration_plate === "string" ? { registrationPlate: input.registration_plate } : {}),
      },
      supplements,
      stageStates: (run.stage_states ?? {}) as AnalysisRunContext["stageStates"],
    };
  }

  async saveStageResult(input: {
    analysisId: string;
    runId: string;
    stage: AnalysisStage;
    stageStates: AnalysisRunContext["stageStates"];
    result: VersionedStageResult;
  }): Promise<void> {
    const stageStates = { ...input.stageStates, [input.stage]: input.result };
    const [{ error: runError }, { error: analysisError }] = await Promise.all([
      this.client
        .from("analysis_runs")
        .update({ stage_states: stageStates, status: "running" })
        .eq("id", input.runId)
        .eq("analysis_id", input.analysisId),
      this.client
        .from("analyses")
        .update({ status: "running", updated_at: input.result.completedAt })
        .eq("id", input.analysisId)
        .eq("current_run_id", input.runId),
    ]);
    if (runError) throw new Error("Could not save stage result", { cause: runError });
    if (analysisError) throw new Error("Could not update analysis status", { cause: analysisError });
  }

  async publishRun(input: {
    analysisId: string;
    runId: string;
    status: AnalysisStatus;
    verdict: Verdict | null;
    confidence: ConfidenceBand | null;
    completedAt: string;
  }): Promise<void> {
    const [{ error: runError }, { error: analysisError }] = await Promise.all([
      this.client
        .from("analysis_runs")
        .update({ status: input.status, completed_at: input.completedAt })
        .eq("id", input.runId)
        .eq("analysis_id", input.analysisId),
      this.client
        .from("analyses")
        .update({
          status: input.status,
          verdict: input.verdict,
          confidence: input.confidence,
          updated_at: input.completedAt,
        })
        .eq("id", input.analysisId)
        .eq("current_run_id", input.runId),
    ]);
    if (runError) throw new Error("Could not publish analysis run", { cause: runError });
    if (analysisError) throw new Error("Could not publish analysis report", { cause: analysisError });
  }

  async finalizeAssembly(input: {
    analysisId: string;
    runId: string;
    result: VersionedStageResult;
    status: AnalysisStatus;
    verdict: Verdict | null;
    confidence: ConfidenceBand | null;
    completedAt: string;
  }): Promise<void> {
    const { error } = await this.client.rpc("finalize_analysis_report", {
      p_analysis_id: input.analysisId,
      p_run_id: input.runId,
      p_assembly_result: input.result,
      p_status: input.status,
      p_verdict: input.verdict,
      p_confidence: input.confidence,
      p_completed_at: input.completedAt,
    });
    if (error) throw new Error("Could not finalize analysis report", { cause: error });
  }

  private emptyReport(analysis: AnalysisRow): AnalysisReport {
    return {
      publicId: analysis.public_id,
      status: analysis.status,
      locale: analysis.locale,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      vehicleFacts: [],
      evidence: [],
      findings: [],
      actions: [],
      sources: {},
      warnings: [],
      updatedAt: analysis.updated_at,
    };
  }

  private async loadRunLineage(analysisId: string, runId: string): Promise<string[]> {
    const lineage: string[] = [];
    const seen = new Set<string>();
    let current: string | null = runId;
    while (current) {
      if (seen.has(current) || lineage.length >= 100) throw new Error("Invalid analysis run lineage");
      seen.add(current);
      lineage.push(current);
      const lineageResult: { data: { parent_run_id: string | null } | null; error: unknown } = await this.client
        .from("analysis_runs")
        .select("parent_run_id")
        .eq("analysis_id", analysisId)
        .eq("id", current)
        .single();
      if (lineageResult.error) throw new Error("Could not load analysis run lineage", { cause: lineageResult.error });
      const parentRunId: string | null | undefined = lineageResult.data?.parent_run_id;
      current = typeof parentRunId === "string" ? parentRunId : null;
    }
    return lineage;
  }

  private async findingEvidence(ids: string[]): Promise<[unknown[] | null, unknown]> {
    const { data, error } = await this.client
      .from("finding_evidence")
      .select("finding_id, evidence_id")
      .in("finding_id", ids);
    return [data, error];
  }
}
