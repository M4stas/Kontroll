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

function requireData<T>(data: T | null, error: unknown, operation: string): T {
  if (error) throw new Error(operation, { cause: error });
  if (data === null) throw new Error(`${operation}: no data returned`);
  return data;
}

function warningFromFailure(failure: unknown): string[] {
  if (!failure) return [];
  if (typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return [message];
  }
  return ["The current analysis run reported a failure."];
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

export class AnalysesRepository {
  constructor(private readonly client: SupabaseClient) {}

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

    const [factsResult, snapshotsResult, evidenceResult, findingsResult, actionsResult, runResult] =
      await Promise.all([
        this.client.from("vehicle_facts").select("*").eq("analysis_id", analysis.id).eq("run_id", runId),
        this.client.from("source_snapshots").select("*").eq("analysis_id", analysis.id).eq("run_id", runId),
        this.client.from("evidence").select("*").eq("analysis_id", analysis.id).eq("run_id", runId),
        this.client.from("findings").select("*").eq("analysis_id", analysis.id).eq("run_id", runId),
        this.client.from("actions").select("*").eq("analysis_id", analysis.id).eq("run_id", runId),
        this.client.from("analysis_runs").select("failure").eq("id", runId).single(),
      ]);

    const facts = requireData(factsResult.data, factsResult.error, "Could not load vehicle facts") as Array<Record<string, unknown>>;
    const snapshots = requireData(snapshotsResult.data, snapshotsResult.error, "Could not load source snapshots") as Array<Record<string, unknown>>;
    const evidenceRows = requireData(evidenceResult.data, evidenceResult.error, "Could not load evidence") as Array<Record<string, unknown>>;
    const findingRows = requireData(findingsResult.data, findingsResult.error, "Could not load findings") as Array<Record<string, unknown>>;
    const actionRows = requireData(actionsResult.data, actionsResult.error, "Could not load actions") as Array<Record<string, unknown>>;
    const run = requireData(runResult.data, runResult.error, "Could not load analysis run") as { failure: unknown };

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
    const sources = Object.fromEntries(
      snapshots.map((row) => {
        const id = row.id as string;
        const summary: SourceSummary = {
          verification: sourceVerification(
            id,
            row.extraction_status as string,
            evidenceForSources,
          ),
        };
        if (typeof row.source_url === "string") summary.url = row.source_url;
        return [id, summary];
      }),
    );

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
      warnings: warningFromFailure(run.failure),
      updatedAt: analysis.updated_at,
    };
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

  private async findingEvidence(ids: string[]): Promise<[unknown[] | null, unknown]> {
    const { data, error } = await this.client
      .from("finding_evidence")
      .select("finding_id, evidence_id")
      .in("finding_id", ids);
    return [data, error];
  }
}
