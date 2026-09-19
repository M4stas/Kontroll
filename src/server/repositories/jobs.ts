import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisStage } from "@/analysis/stages";

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

  async enqueue(job: {
    analysisId: string;
    runId: string;
    stage: AnalysisStage;
  }): Promise<void> {
    if (job.stage === "assemble_report") {
      const { data, error } = await this.client
        .from("analysis_jobs")
        .update({
          status: "queued",
          available_at: new Date().toISOString(),
          completed_at: null,
          last_error: null,
        })
        .eq("analysis_id", job.analysisId)
        .eq("run_id", job.runId)
        .eq("stage", job.stage)
        .eq("status", "complete")
        .select("id");
      if (error) throw new Error(`Could not requeue analysis job: ${error.message}`, { cause: error });
      if ((data as Array<{ id: string }> | null)?.length) return;
    }
    const { error } = await this.client.from("analysis_jobs").upsert(
      {
        analysis_id: job.analysisId,
        run_id: job.runId,
        stage: job.stage,
        idempotency_key: `${job.analysisId}:${job.runId}:${job.stage}`,
      },
      { onConflict: "analysis_id,run_id,stage", ignoreDuplicates: true },
    );

    if (error) throw new Error(`Could not enqueue analysis job: ${error.message}`, { cause: error });
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    await this.transition("complete_analysis_job", "complete analysis job", {
      p_job_id: jobId,
      p_worker_id: workerId,
    });
  }

  async retry(jobId: string, workerId: string, availableAt: Date, message: string): Promise<void> {
    await this.transition("retry_analysis_job", "retry analysis job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_available_at: availableAt.toISOString(),
      p_message: message,
    });
  }

  async fail(jobId: string, workerId: string, message: string): Promise<void> {
    await this.transition("fail_analysis_job", "fail analysis job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_message: message,
    });
  }

  async renew(jobId: string, workerId: string, leaseSeconds: number): Promise<void> {
    await this.transition("renew_analysis_job", "renew analysis job lease", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
  }

  private async transition(
    functionName: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const { data, error } = await this.client.rpc(functionName, args);
    if (error) throw new Error(`Could not ${operation}: ${error.message}`, { cause: error });
    if (!(data as AnalysisJobRow[] | null)?.[0]) {
      throw new Error(`Could not ${operation}: active lease not found`);
    }
  }
}
