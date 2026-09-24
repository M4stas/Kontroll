import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type {
  Action,
  Evidence,
  EvidenceRelation,
  Finding,
  VerificationState,
  VehicleFact,
} from "@/domain/analysis";
import type { AnalysisStage } from "@/analysis/stages";

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
  producerStage?: Extract<AnalysisStage, "capture_listing" | "research">;
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
    const snapshots = await this.saveSourceSnapshots([input], input.producerStage ?? "capture_listing");
    const id = snapshots[0];
    if (!id) throw new Error("Could not create source snapshot: no data returned");
    return { id };
  }

  async saveSourceSnapshots(
    inputs: SourceSnapshotInput[],
    producerStage: Extract<AnalysisStage, "capture_listing" | "research">,
    scope?: { analysisId: string; runId: string },
  ): Promise<string[]> {
    const first = inputs[0] ?? scope;
    if (!first) return [];
    const { data, error } = await this.client.rpc("save_stage_source_snapshots", {
      p_sources: inputs.map((input) => ({
        id: input.id ?? randomUUID(),
        analysis_id: input.analysisId,
        run_id: input.runId,
        source_type: input.sourceType,
        source_url: input.sourceUrl ?? null,
        captured_at: input.capturedAt ?? null,
        content_hash: input.contentHash ?? null,
        storage_key: input.storageKey ?? null,
        extraction_status: input.extractionStatus ?? "queued",
        metadata: input.metadata ?? {},
      })),
      p_analysis_id: first.analysisId,
      p_run_id: first.runId,
      p_stage: producerStage,
    });
    throwOnError(error, "Could not save source snapshots");
    return ((data ?? []) as Array<{ snapshot_id: string }>).map((row) => row.snapshot_id);
  }

  async saveVehicleFacts(inputs: VehicleFactInput[], scope?: { analysisId: string; runId: string }): Promise<void> {
    const first = inputs[0] ?? scope;
    if (!first) return;
    const { error } = await this.client.rpc("save_stage_vehicle_facts", {
      p_facts: inputs.map((input) => ({
        id: input.id ?? randomUUID(),
        analysis_id: input.analysisId,
        run_id: input.runId,
        fact_key: input.key,
        fact_value: input.value,
        normalized_value: input.normalizedValue ?? null,
        source_snapshot_id: input.sourceId,
        verification: input.verification,
        match_confidence: input.confidence,
      })),
      p_analysis_id: first.analysisId,
      p_run_id: first.runId,
    });
    throwOnError(error, "Could not save vehicle facts");
  }

  async saveEvidence(
    inputs: EvidenceInput[],
    scope?: { analysisId: string; runId: string; producerStage: Extract<AnalysisStage, "baseline_checks" | "enrich"> },
  ): Promise<string[]> {
    const first = inputs[0];
    const resolved = scope ?? (first ? {
      analysisId: first.analysisId,
      runId: first.runId,
      producerStage: "baseline_checks" as const,
    } : null);
    if (!resolved) return [];
    const { data, error } = await this.client.rpc("save_stage_evidence", {
      p_evidence: inputs.map((input) => ({
        id: input.id ?? randomUUID(),
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
      p_analysis_id: resolved.analysisId,
      p_run_id: resolved.runId,
      p_stage: resolved.producerStage,
    });
    throwOnError(error, "Could not save evidence");
    return ((data ?? []) as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
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
