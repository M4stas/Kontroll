import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnalysisJob } from './jobs';
import type { PhotoSpan } from '@/diagnostics/contracts';
export class PhotoTimingsRepository {
  constructor(private readonly client: SupabaseClient, private readonly workerId: string) {}
  async write(job: AnalysisJob, spans: PhotoSpan[], signal: AbortSignal): Promise<void> {
    const { error } = await this.client.rpc('record_photo_timing_spans', {
      p_analysis_id: job.analysisId, p_run_id: job.runId, p_job_id: job.id,
      p_worker_id: this.workerId, p_job_lease_attempt: job.attempts, p_spans: spans,
    }).abortSignal(signal);
    if (error) throw Error('Timing collection unavailable');
  }
}
