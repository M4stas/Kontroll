import { expect,it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DiagnosticsRepository } from '@/server/repositories/diagnostics';
it('retains healthy reviews when the additive timing source fails',async()=>{
 const tables:Record<string,unknown>={analyses:{id:'analysis',current_run_id:'run'},analysis_runs:{id:'run',status:'running',created_at:'2026-10-10T12:00:00Z',completed_at:null},review_run_snapshots:{snapshot:{imageManifest:{images:[{evidenceId:'photo',selected:true,status:'accepted'}]},passes:{}}},review_executions:[],review_attempts:[],analysis_jobs:[]};
 const client={from(table:string){ const result=table==='diagnostic_photo_spans'?{data:null,error:Error('private database error')}:{data:tables[table],error:null}; const query={select(){return query;},eq(){return query;},order(){return query;},limit(){return query;},range(){return query;},maybeSingle(){return Promise.resolve(result);},then(resolve:(value:unknown)=>unknown,reject?:(error:unknown)=>unknown){return Promise.resolve(result).then(resolve,reject);}};return query;}};
 const value=await new DiagnosticsRepository(client as unknown as SupabaseClient).load('public');
 expect(value?.reviews.find(review=>review.evidenceId==='photo')).toMatchObject({pass:'image',state:'waiting'});
 expect(value?.availability.internalTimings).toBe('unavailable');
 expect(JSON.stringify(value)).not.toContain('private database error');
});
