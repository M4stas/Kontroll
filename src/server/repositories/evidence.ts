import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Action,
  Evidence,
  EvidenceRelation,
  Finding,
  VerificationState,
  VehicleFact,
} from "@/domain/analysis";

export interface SourceSnapshotInput {
  id?: string;
  analysisId: string;
  runId: string;
  sourceType: string;
  sourceUrl?: string;
  capturedAt?: string;
  contentHash?: string;
  storageKey?: string;
  extractionStatus?: "queued" | "running" | "complete" | "unavailable" | "failed";
  metadata?: Record<string, unknown>;
}

export type VehicleFactInput = VehicleFact & { id?: string; analysisId: string; runId: string };
export type EvidenceInput = Omit<Evidence, "id"> & { id?: string; analysisId: string; runId: string };
export type FindingInput = Omit<Finding, "id" | "evidenceIds"> & {
  id?: string;
  analysisId: string;
  runId: string;
  evidenceLinks: Array<{ evidenceId: string; relation: EvidenceRelation }>;
};
export type ActionInput = Omit<Action, "id"> & { id?: string; analysisId: string; runId: string };

function throwOnError(error: unknown, operation: string): void {
  if (error) throw new Error(operation, { cause: error });
}

export class EvidenceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createSourceSnapshot(input: SourceSnapshotInput): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from("source_snapshots")
      .upsert({
        ...(input.id ? { id: input.id } : {}),
        analysis_id: input.analysisId,
        run_id: input.runId,
        source_type: input.sourceType,
        source_url: input.sourceUrl ?? null,
        captured_at: input.capturedAt ?? new Date().toISOString(),
        content_hash: input.contentHash ?? null,
        storage_key: input.storageKey ?? null,
        extraction_status: input.extractionStatus ?? "queued",
        metadata: input.metadata ?? {},
      }, { onConflict: "id" })
      .select("id")
      .single();
    throwOnError(error, "Could not create source snapshot");
    if (!data) throw new Error("Could not create source snapshot: no data returned");
    return { id: (data as { id: string }).id };
  }

  async saveVehicleFacts(inputs: VehicleFactInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const { error } = await this.client.from("vehicle_facts").upsert(
      inputs.map((input) => ({
        ...(input.id ? { id: input.id } : {}),
        analysis_id: input.analysisId,
        run_id: input.runId,
        fact_key: input.key,
        fact_value: input.value,
        normalized_value: input.normalizedValue ?? null,
        source_snapshot_id: input.sourceId,
        verification: input.verification,
        match_confidence: input.confidence,
      })), { onConflict: "id" },
    );
    throwOnError(error, "Could not save vehicle facts");
  }

  async saveEvidence(inputs: EvidenceInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from("evidence")
      .upsert(
        inputs.map((input) => ({
          ...(input.id ? { id: input.id } : {}),
          analysis_id: input.analysisId,
          run_id: input.runId,
          source_snapshot_id: input.sourceId,
          source_class: input.sourceClass,
          claim: input.claim,
          applicability: input.applicability,
          confidence: input.confidence,
          verification: input.verification,
          captured_at: input.capturedAt,
        })),
        { onConflict: "id" },
      )
      .select("id");
    throwOnError(error, "Could not save evidence");
    return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  }

  async saveFindings(inputs: FindingInput[], replaceRun?: { analysisId: string; runId: string }): Promise<string[]> {
    const { data, error } = await this.client.rpc("save_findings", {
      p_findings: inputs.map((input) => ({
        ...(input.id ? { id: input.id } : {}),
        analysis_id: input.analysisId,
        run_id: input.runId,
        category: input.category,
        severity: input.severity,
        state: input.state,
        title: input.title,
        explanation: input.explanation,
        next_action: input.nextAction,
        origin: input.origin ?? "deterministic",
        evidence_links: input.evidenceLinks.map((link) => ({
          evidence_id: link.evidenceId,
          relation: link.relation,
        })),
      })),
      p_replace_analysis_id: replaceRun?.analysisId ?? null,
      p_replace_run_id: replaceRun?.runId ?? null,
    });
    throwOnError(error, "Could not save findings");
    return ((data ?? []) as Array<{ finding_id: string }>).map((row) => row.finding_id);
  }

  async saveActions(inputs: ActionInput[], replaceRun?: { analysisId: string; runId: string }): Promise<string[]> {
    const { data, error } = await this.client.rpc("save_actions", {
      p_actions: inputs.map((input) => ({
        ...(input.id ? { id: input.id } : {}),
        analysis_id: input.analysisId,
        run_id: input.runId,
        kind: input.kind,
        title: input.title,
        instructions: input.instructions,
        status: input.status,
        finding_id: input.findingId ?? null,
      })),
      p_replace_analysis_id: replaceRun?.analysisId ?? null,
      p_replace_run_id: replaceRun?.runId ?? null,
    });
    throwOnError(error, "Could not save actions");
    return ((data ?? []) as Array<{ action_id: string }>).map((row) => row.action_id);
  }

  async markSourceUnavailable(snapshotId: string): Promise<void> {
    const { error } = await this.client
      .from("source_snapshots")
      .update({ extraction_status: "unavailable" })
      .eq("id", snapshotId);
    throwOnError(error, "Could not mark source unavailable");
  }

  async setEvidenceVerification(id: string, verification: VerificationState): Promise<void> {
    const { error } = await this.client.from("evidence").update({ verification }).eq("id", id);
    throwOnError(error, "Could not update evidence verification");
  }
}
