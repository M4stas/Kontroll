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

export interface SubmissionWrite {
  kind: "seller_answer" | "buyer_note" | "image" | "screenshot" | "document";
  providedBy: "seller" | "buyer";
  textContent?: string;
  storageKey?: string;
  mimeType?: string;
  identityCorrection?: "vin" | "registrationPlate";
}

export interface AcceptedSubmissionGroup {
  runId: string;
  queuedStages: AnalysisStage[];
  created: boolean;
}

export interface ReconciledSubmissionGroup extends Omit<AcceptedSubmissionGroup, "created"> {
  referencedStorageKeys: string[];
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

  async retryCurrentReview(analysisId: string): Promise<boolean> {
    const {data,error}=await this.client.rpc('retry_current_review',{p_analysis_id:analysisId});
    if(error)throw new Error('Could not retry the current review',{cause:error});
    return data===true;
  }

  async lease(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null> {
    const { data, error } = await this.client.rpc("lease_analysis_job", {
      worker_id: workerId,
      lease_seconds: leaseSeconds,
    });

    if (error) throw new Error("Could not lease analysis job", { cause: error });
    const row = (data as AnalysisJobRow[] | null)?.[0];
    return row ? mapJob(row) : null;
  }

  async leaseForAnalysis(workerId: string, leaseSeconds: number, analysisId: string): Promise<AnalysisJob | null> {
    const { data, error } = await this.client.rpc("lease_analysis_job_scoped", {
      worker_id: workerId,
      lease_seconds: leaseSeconds,
      p_analysis_id: analysisId,
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
      const { data, error } = await this.client.rpc("requeue_partial_assembly_job", {
        p_analysis_id: job.analysisId,
        p_run_id: job.runId,
      });
      if (error) throw new Error(`Could not requeue analysis job: ${error.message}`, { cause: error });
      if (data === true) return;
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

  async enqueueMany(input: {
    analysisId: string;
    idempotencyKey: string;
    submissions: SubmissionWrite[];
    stages: AnalysisStage[];
  }): Promise<AcceptedSubmissionGroup> {
    const { data, error } = await this.client.rpc("accept_analysis_submission_group", {
      p_analysis_id: input.analysisId,
      p_idempotency_key: input.idempotencyKey,
      p_submissions: input.submissions.map((submission) => ({
        kind: submission.kind,
        provided_by: submission.providedBy,
        text_content: submission.textContent ?? null,
        storage_key: submission.storageKey ?? null,
        mime_type: submission.mimeType ?? null,
        identity_correction: submission.identityCorrection ?? null,
      })),
      p_stages: input.stages,
    });
    if (error) throw new Error(`Could not accept submission group: ${error.message}`, { cause: error });
    const row = (data as Array<{ run_id: string; queued_stages: AnalysisStage[]; created: boolean }> | null)?.[0];
    if (!row) throw new Error("Could not accept submission group: no data returned");
    return { runId: row.run_id, queuedStages: row.queued_stages, created: row.created };
  }

  async findAcceptedSubmissionGroup(
    analysisId: string,
    idempotencyKey: string,
  ): Promise<ReconciledSubmissionGroup | null> {
    const { data: run, error: runError } = await this.client
      .from("analysis_runs")
      .select("id")
      .eq("analysis_id", analysisId)
      .eq("submission_idempotency_key", idempotencyKey)
      .maybeSingle();
    if (runError) throw new Error("Could not reconcile submission group", { cause: runError });
    if (!run) return null;

    const [jobs, submissions] = await Promise.all([
      this.client.from("analysis_jobs").select("stage").eq("analysis_id", analysisId).eq("run_id", run.id),
      this.client.from("submissions").select("storage_key").eq("analysis_id", analysisId).eq("run_id", run.id),
    ]);
    if (jobs.error) throw new Error("Could not reconcile submission jobs", { cause: jobs.error });
    if (submissions.error) throw new Error("Could not reconcile submission files", { cause: submissions.error });
    const order: AnalysisStage[] = [
      "capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report",
    ];
    const queuedStages = (jobs.data ?? [])
      .map((row) => row.stage as AnalysisStage)
      .sort((left, right) => order.indexOf(left) - order.indexOf(right));
    return {
      runId: run.id as string,
      queuedStages,
      referencedStorageKeys: (submissions.data ?? []).flatMap((row) => (
        typeof row.storage_key === "string" ? [row.storage_key] : []
      )),
    };
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
    if (error) {
      const failure=new Error(`Could not ${operation}: ${error.message}`,{cause:error});
      if(error.message==='analysis job active lease not found for worker')throw Object.assign(failure,{leaseLost:true});
      throw failure;
    }
    if (!(data as AnalysisJobRow[] | null)?.[0]) {
      throw Object.assign(new Error(`Could not ${operation}: active lease not found`),{leaseLost:true});
    }
  }

}
