import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Action,
  Evidence,
  Finding,
  VerificationState,
  VehicleFact,
} from "@/domain/analysis";

export interface SourceSnapshotInput {
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

export type VehicleFactInput = VehicleFact & { analysisId: string; runId: string };
export type EvidenceInput = Omit<Evidence, "id"> & { id?: string; analysisId: string; runId: string };
export type FindingInput = Omit<Finding, "id"> & { id?: string; analysisId: string; runId: string };
export type ActionInput = Omit<Action, "id"> & { id?: string; analysisId: string; runId: string };

function throwOnError(error: unknown, operation: string): void {
  if (error) throw new Error(operation, { cause: error });
}

export class EvidenceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createSourceSnapshot(input: SourceSnapshotInput): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from("source_snapshots")
      .insert({
        analysis_id: input.analysisId,
        run_id: input.runId,
        source_type: input.sourceType,
        source_url: input.sourceUrl ?? null,
        captured_at: input.capturedAt ?? new Date().toISOString(),
        content_hash: input.contentHash ?? null,
        storage_key: input.storageKey ?? null,
        extraction_status: input.extractionStatus ?? "queued",
        metadata: input.metadata ?? {},
      })
      .select("id")
      .single();
    throwOnError(error, "Could not create source snapshot");
    if (!data) throw new Error("Could not create source snapshot: no data returned");
    return { id: (data as { id: string }).id };
  }

  async saveVehicleFacts(inputs: VehicleFactInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const { error } = await this.client.from("vehicle_facts").insert(
      inputs.map((input) => ({
        analysis_id: input.analysisId,
        run_id: input.runId,
        fact_key: input.key,
        fact_value: input.value,
        normalized_value: input.normalizedValue ?? null,
        source_snapshot_id: input.sourceId,
        verification: input.verification,
        match_confidence: input.confidence,
      })),
    );
    throwOnError(error, "Could not save vehicle facts");
  }

  async saveEvidence(inputs: EvidenceInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from("evidence")
      .insert(
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
      )
      .select("id");
    throwOnError(error, "Could not save evidence");
    return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  }

  async saveFindings(inputs: FindingInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from("findings")
      .insert(
        inputs.map((input) => ({
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
        })),
      )
      .select("id");
    throwOnError(error, "Could not save findings");
    const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    const links = inputs.flatMap((input, index) =>
      input.evidenceIds.map((evidenceId) => ({
        finding_id: ids[index],
        evidence_id: evidenceId,
        relation: "supports",
      })),
    );
    if (links.length > 0) {
      const { error: linkError } = await this.client.from("finding_evidence").insert(links);
      throwOnError(linkError, "Could not link finding evidence");
    }
    return ids;
  }

  async saveActions(inputs: ActionInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from("actions")
      .insert(
        inputs.map((input) => ({
          ...(input.id ? { id: input.id } : {}),
          analysis_id: input.analysisId,
          run_id: input.runId,
          kind: input.kind,
          title: input.title,
          instructions: input.instructions,
          status: input.status,
          finding_id: input.findingId ?? null,
        })),
      )
      .select("id");
    throwOnError(error, "Could not save actions");
    return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
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
