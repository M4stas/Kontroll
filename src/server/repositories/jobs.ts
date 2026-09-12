import type { SupabaseClient } from "@supabase/supabase-js";

export type JobStatus = "queued" | "leased" | "complete" | "failed";

export interface AnalysisJob {
  id: string;
  analysisId: string;
  runId: string;
  stage: string;
  status: JobStatus;
  attempts: number;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  availableAt: string;
  lastError: unknown;
  createdAt: string;
  completedAt: string | null;
}

interface AnalysisJobRow {
  id: string;
  analysis_id: string;
  run_id: string;
  stage: string;
  status: JobStatus;
  attempts: number;
  leased_by: string | null;
  lease_expires_at: string | null;
  available_at: string;
  last_error: unknown;
  created_at: string;
  completed_at: string | null;
}

function mapJob(row: AnalysisJobRow): AnalysisJob {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    runId: row.run_id,
    stage: row.stage,
    status: row.status,
    attempts: row.attempts,
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class JobsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async lease(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null> {
    const { data, error } = await this.client.rpc("lease_analysis_job", {
      worker_id: workerId,
      lease_seconds: leaseSeconds,
    });

    if (error) throw new Error("Could not lease analysis job", { cause: error });
    const row = (data as AnalysisJobRow[] | null)?.[0];
    return row ? mapJob(row) : null;
  }

  async complete(jobId: string): Promise<void> {
    await this.update(jobId, {
      status: "complete",
      completed_at: new Date().toISOString(),
      leased_by: null,
      lease_expires_at: null,
      last_error: null,
    });
  }

  async retry(jobId: string, availableAt: Date, message: string): Promise<void> {
    await this.update(jobId, {
      status: "queued",
      available_at: availableAt.toISOString(),
      leased_by: null,
      lease_expires_at: null,
      last_error: { message },
    });
  }

  async fail(jobId: string, message: string): Promise<void> {
    await this.update(jobId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      leased_by: null,
      lease_expires_at: null,
      last_error: { message },
    });
  }

  async renew(jobId: string, workerId: string, leaseSeconds: number): Promise<void> {
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    const { error } = await this.client
      .from("analysis_jobs")
      .update({ lease_expires_at: leaseExpiresAt })
      .eq("id", jobId)
      .eq("status", "leased")
      .eq("leased_by", workerId);

    if (error) throw new Error("Could not renew analysis job lease", { cause: error });
  }

  private async update(jobId: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from("analysis_jobs").update(values).eq("id", jobId);
    if (error) throw new Error("Could not update analysis job", { cause: error });
  }
}
