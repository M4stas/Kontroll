import type { SupabaseClient } from "@supabase/supabase-js";
import { projectDiagnostics, type DiagnosticRecords } from "@/diagnostics/project";
import { ReviewResultSchema } from "@/insights/provider";
import { DiagnosticsResultSchema } from "@/diagnostics/contracts";
import { sanitizeReviewAuditValue } from "@/server/repositories/review-executions";
const ATTEMPT_FIELDS =
  "id,execution_id,job_id,worker_id,job_lease_attempt,attempt_number,state,warning_code,started_at,completed_at";
const HISTORY_PAGE_SIZE = 200;
export class DiagnosticsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async load(publicId: string, requestedRunId?: string, offset = 0) {
    const analysis = await this.client
      .from("analyses")
      .select("id,current_run_id")
      .eq("public_id", publicId)
      .maybeSingle();
    if (analysis.error) throw Error("Diagnostics unavailable");
    if (!analysis.data) return null;
    const analysisId = analysis.data.id as string,
      currentRunId = analysis.data.current_run_id as string | null;
    // Checkpoint 1 exposes current run only; discovery always resolves this pointer anew.
    if (requestedRunId && requestedRunId !== currentRunId) return null;
    const runId = currentRunId;
    const base: DiagnosticRecords = {
      publicId,
      analysisId,
      currentRunId,
      run: null,
      snapshot: null,
      executions: [],
      attempts: [],
      jobs: [],
      origins: [],
    };
    if (!runId) return projectDiagnostics(base, new Date().toISOString());
    const [run, snapshot, executions, attempts, jobs, timings] = await Promise.all([
      this.client
        .from("analysis_runs")
        .select("id,status,created_at,completed_at")
        .eq("analysis_id", analysisId)
        .eq("id", runId)
        .maybeSingle(),
      this.client
        .from("review_run_snapshots")
        .select("snapshot")
        .eq("analysis_id", analysisId)
        .eq("run_id", runId)
        .maybeSingle(),
      this.client
        .from("review_executions")
        .select(
          `id,pass,image_evidence_id,result_hash,completed_at,reused_from_execution_id,latest_attempt:review_attempts!review_attempts_execution_id_fkey(${ATTEMPT_FIELDS})`,
        )
        .eq("analysis_id", analysisId)
        .eq("run_id", runId)
        .order("attempt_number", { referencedTable: "latest_attempt", ascending: false })
        .limit(1, { referencedTable: "latest_attempt" })
        .limit(258),
      this.client
        .from("review_attempts")
        .select(
          "id,execution_id,job_id,worker_id,job_lease_attempt,attempt_number,state,warning_code,started_at,completed_at",
        )
        .eq("analysis_id", analysisId)
        .eq("run_id", runId)
        .order("started_at", {
          ascending: false,
        })
        .order("id", {
          ascending: false,
        })
        .range(offset, offset + HISTORY_PAGE_SIZE),
      this.client
        .from("analysis_jobs")
        .select("id,stage,status,leased_by,attempts,lease_expires_at")
        .eq("analysis_id", analysisId)
        .eq("run_id", runId)
        .limit(32),
      this.client.from("diagnostic_photo_spans")
        .select("id,evidence_id,parent_id,phase,state,started_at,completed_at,duration_ms,error_code,omitted_count,job_id,worker_id,job_lease_attempt")
        .eq("analysis_id", analysisId).eq("run_id", runId)
        .order("started_at", { ascending: false }).order("id", { ascending: false }).limit(501)
        .then(result => result, () => ({ data: null, error: true })),
    ]);
    if ([run, snapshot, executions, attempts, jobs].some((x) => x.error)) throw Error("Diagnostics unavailable");
    if (!run.data) return null;
    const reusedIds = (executions.data ?? []).flatMap((x) =>
      x.reused_from_execution_id ? [x.reused_from_execution_id as string] : [],
    );
    const origins = reusedIds.length
      ? await this.client
          .from("review_executions")
          .select("id,run_id,completed_at")
          .eq("analysis_id", analysisId)
          .in("id", reusedIds)
          .limit(258)
      : {
          data: [],
          error: null,
        };
    if (origins.error) throw Error("Diagnostics unavailable");
    const truncated = (attempts.data?.length ?? 0) > HISTORY_PAGE_SIZE;
    const result = projectDiagnostics(
      {
        ...base,
        run: run.data,
        snapshot: snapshot.data?.snapshot ?? null,
        executions: executions.data ?? [],
        attempts: (attempts.data ?? []).slice(0, HISTORY_PAGE_SIZE),
        latestAttempts: (executions.data ?? []).flatMap((row) => row.latest_attempt ?? []),
        jobs: jobs.data ?? [],
        origins: origins.data ?? [],
        truncated,
        spans: (timings.data ?? []).slice(0, 500),
        timingUnavailable: Boolean(timings.error),
        timingTruncated: (timings.data?.length ?? 0) > 500,
      },
      new Date().toISOString(),
    );
    result.nextCursor = truncated ? String(offset + HISTORY_PAGE_SIZE) : null;
    return result;
  }
  async result(publicId: string, runId: string, executionId: string) {
    const snapshot = await this.load(publicId, runId);
    if (!snapshot) return null;
    const review = snapshot.reviews.find((x) => x.executionId === executionId);
    if (!review) return null;
    if (!review.resultAvailable)
      return {
        executionId,
        runId,
        state: review.state,
        result: null,
        reusedFrom: review.reusedFrom,
      };
    const { data, error } = await this.client
      .from("review_executions")
      .select("result,result_hash,completed_at")
      .eq("analysis_id", snapshot.owner.analysisId)
      .eq("run_id", runId)
      .eq("id", executionId)
      .maybeSingle();
    if (error) throw Error("Result unavailable");
    if (!data?.result_hash || !data.completed_at) return null;
    const result = ReviewResultSchema.parse(data.result);
    // Successful committed reviews have no warnings. Do not return provider warning messages.
    if (result.warnings.length) return null;
    const safeResult = ReviewResultSchema.parse(
      sanitizeReviewAuditValue({
        schemaVersion: result.schemaVersion,
        observations: result.observations,
        warnings: [],
      }),
    );
    return DiagnosticsResultSchema.parse({
      executionId,
      runId,
      state: review.state,
      result: safeResult,
      reusedFrom: review.reusedFrom,
    });
  }
}
