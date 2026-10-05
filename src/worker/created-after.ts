import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { JobsRepository } from '@/server/repositories/jobs';

export function parseWorkerArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--created-after') {
    throw new Error('Usage: npm run worker -- [--created-after ISO_TIMESTAMP]');
  }
  return new Date(z.iso.datetime({ offset: true }).parse(args[1])).toISOString();
}

/** Restrict analysis creation time, while the existing RPC retains atomic lease checks. */
export function createWorkerLease(
  client: SupabaseClient,
  jobs: Pick<JobsRepository, 'lease' | 'leaseForAnalysis'>,
  createdAfter?: string,
) {
  let offset = 0;
  return async (workerId: string, leaseSeconds: number) => {
    if (!createdAfter) return jobs.lease(workerId, leaseSeconds);
    const now = new Date().toISOString();
    const { data, error } = await client.from('analysis_jobs')
      .select('analysis_id,analyses!inner(created_at)')
      .gte('analyses.created_at', createdAfter)
      .lte('available_at', now)
      .or(`status.eq.queued,and(status.eq.leased,lease_expires_at.lte.${now})`)
      .order('available_at').order('created_at').order('id')
      .range(offset, offset + 31);
    if (error) throw new Error('Could not find scoped analysis jobs', { cause: error });
    // Advance through bounded pages even if dependency-blocked jobs fill a page.
    offset = data.length === 32 ? offset + 32 : 0;
    for (const analysisId of new Set(data.map(row => row.analysis_id as string))) {
      const job = await jobs.leaseForAnalysis(workerId, leaseSeconds, analysisId);
      if (job) return job;
    }
    return null;
  };
}
