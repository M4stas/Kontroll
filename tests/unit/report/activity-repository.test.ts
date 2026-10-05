import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadReportActivity } from '@/server/repositories/report-activity';
function client(rows: Array<{analysis_id:string;run_id:string;status:string;lease_expires_at?:string}>, fail=false) {
 return {from:()=>({select:()=>{const filters:Record<string,string>={};const query={eq:(key:string,value:string)=>{filters[key]=value;return query;},then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:rows.filter(row=>Object.entries(filters).every(([key,value])=>row[key as keyof typeof row]===value)),error:fail?new Error('unavailable'):null}).then(resolve)};return query;}})} as unknown as SupabaseClient;
}
it('exposes leases only from the current analysis and run',async()=>{
 const db=client([{analysis_id:'a',run_id:'old',status:'leased',lease_expires_at:'2099-01-01T00:00:00Z'},{analysis_id:'b',run_id:'current',status:'leased',lease_expires_at:'2099-01-01T00:00:00Z'},{analysis_id:'a',run_id:'current',status:'leased',lease_expires_at:'2026-10-05T12:00:00Z'}]);
 expect(await loadReportActivity(db,'a','current')).toEqual({state:'running',leaseExpiresAt:'2026-10-05T12:00:00Z'});
});
it('reports queued work without inventing a lease',async()=>expect(await loadReportActivity(client([{analysis_id:'a',run_id:'r',status:'queued'}]),'a','r')).toEqual({state:'queued'}));
it('reports unavailable activity as stale while preserving the report',async()=>expect(await loadReportActivity(client([],true),'a','r')).toEqual({state:'stale'}));

it('marks an expired worker lease stale so recovery stays available',async()=>{
 expect(await loadReportActivity(client([{analysis_id:'a',run_id:'r',status:'leased',lease_expires_at:'1999-01-01T00:00:00Z'}]),'a','r')).toEqual({state:'stale'});
});
