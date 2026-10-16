import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnalysisReport } from '@/domain/analysis';
/** Lease expiry is renewed by the worker; report reads never extend it. */
export async function loadReportActivity(client:SupabaseClient,analysisId:string,runId:string):Promise<NonNullable<AnalysisReport['activity']>> {
 try {
  const {data,error}=await client.from('analysis_jobs').select('status, lease_expires_at').eq('analysis_id',analysisId).eq('run_id',runId);
  if(error) return {state:'stale',runId};
  const leases=(data??[]).filter(job=>job.status==='leased').map(job=>job.lease_expires_at as string).filter(expiry=>Date.parse(expiry)>Date.now()).sort();
  if(leases.length) return {state:'running',leaseExpiresAt:leases.at(-1),runId};
  // A queued stage cannot start while an earlier stage holds an expired lease.
  return {state:(data??[]).some(job=>job.status==='leased')?'stale':(data??[]).some(job=>job.status==='queued')?'queued':'stopped',runId};
 } catch {return {state:'stale',runId};}
}
