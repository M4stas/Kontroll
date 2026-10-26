import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { AnalysesRepository } from '@/server/repositories/analyses';
import { JobsRepository } from '@/server/repositories/jobs';
import { stableId } from '@/lib/stable-id';
let client: SupabaseClient;
const created: string[] = [];
beforeAll(() => {
 const values = Object.fromEntries((process.env.SUPABASE_CLI_ENTRY
   ? execFileSync(process.execPath, [process.env.SUPABASE_CLI_ENTRY, "status", "-o", "env"], { encoding: "utf8" })
   : execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" })).trim().split('\n').map(line => {const i=line.indexOf('=');return [line.slice(0,i),JSON.parse(line.slice(i+1))];}));
 if (!['127.0.0.1','localhost'].includes(new URL(values.API_URL).hostname)) throw Error('Photo timing tests require disposable local Supabase');
 client = createClient(values.API_URL,values.SERVICE_ROLE_KEY ?? values.SECRET_KEY,{auth:{persistSession:false}});
});
afterEach(async () => { for (const id of created) await client.from('analyses').delete().eq('id',id); created.length=0; });
async function fixture() {
 const analyses=new AnalysesRepository(client);
 const {publicId}=await analyses.create({accessTokenHash:randomUUID(),locale:'en',listingUrl:'https://example.test/photo',inputType:'pasted_text',pastedText:'Toyota'});
 const analysisId=(await analyses.loadAnalysisId(publicId))!; created.push(analysisId);
 const job=(await new JobsRepository(client).leaseForAnalysis('photo-test',60,analysisId))!;
 const url='https://img.auto24.ee/photo.jpg';
 await client.from('analysis_inputs').update({capture_snapshot:{imageUrls:[url]}}).eq('analysis_id',analysisId);
 const evidenceId=stableId(`${analysisId}:${job.runId}:capture-image:${stableId(`${analysisId}:listing-photo:0:${url}`)}`);
 const row={id:randomUUID(),evidenceId,parentId:null,phase:'capture_prepare',state:'running',startedAt:new Date().toISOString(),completedAt:null,durationMs:null,errorCode:null};
 const write=(rows:unknown[],overrides={})=>client.rpc('record_photo_timing_spans',{p_analysis_id:analysisId,p_run_id:job.runId,p_job_id:job.id,p_worker_id:'photo-test',p_job_lease_attempt:job.attempts,p_spans:rows,...overrides});
 return {analysisId,job,row,write};
}
it('accepts pre-evidence capture IDs but rejects foreign evidence, stale lease and foreign parent',async()=>{
 const f=await fixture();
 expect((await f.write([f.row])).error).toBeNull();
 expect((await f.write([{...f.row,id:randomUUID(),evidenceId:randomUUID()}])).error).toBeTruthy();
 expect((await f.write([{...f.row,id:randomUUID(),parentId:randomUUID()}])).error).toBeTruthy();
 expect((await f.write([f.row],{p_job_lease_attempt:f.job.attempts+1})).error).toBeTruthy();
 expect((await f.write([f.row],{p_worker_id:'foreign'})).error).toBeTruthy();
 await client.from('analyses').update({current_run_id:null}).eq('id',f.analysisId);
 expect((await f.write([f.row])).error).toBeTruthy();
});
it('keeps completion immutable against late starts and bounds rows per owned attempt',async()=>{
 const f=await fixture();
 expect((await f.write([f.row])).error).toBeNull();
 const complete={...f.row,state:'complete',completedAt:new Date().toISOString(),durationMs:12};
 expect((await f.write([complete])).error).toBeNull();
 expect((await f.write([f.row])).error).toBeNull();
 const result=await client.from('diagnostic_photo_spans').select('state,duration_ms').eq('id',f.row.id).single();
 expect(result.data).toEqual({state:'complete',duration_ms:12});
 for(let i=0;i<15;i++) expect((await f.write(Array.from({length:32},()=>({...f.row,id:randomUUID()})))).error).toBeNull();
 expect((await f.write(Array.from({length:32},()=>({...f.row,id:randomUUID()})))).error).toBeTruthy();
});
it('denies direct writes, unauthenticated reads and RPC execution, and cascades cleanup',async()=>{
 const f=await fixture();
 expect((await f.write([f.row])).error).toBeNull();
 const direct=await client.from('diagnostic_photo_spans').insert({id:randomUUID(),analysis_id:f.analysisId,run_id:f.job.runId,job_id:f.job.id,worker_id:'photo-test',job_lease_attempt:f.job.attempts,evidence_id:f.row.evidenceId,phase:'download',state:'running',started_at:f.row.startedAt});
 expect(direct.error).toBeTruthy();
 const values=Object.fromEntries((process.env.SUPABASE_CLI_ENTRY
   ? execFileSync(process.execPath, [process.env.SUPABASE_CLI_ENTRY, "status", "-o", "env"], { encoding: "utf8" })
   : execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" })).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),JSON.parse(line.slice(i+1))];}));
 const anon=createClient(values.API_URL,values.ANON_KEY ?? values.PUBLISHABLE_KEY,{auth:{persistSession:false,storageKey:'photo-anon-test'}});
 expect((await anon.from('diagnostic_photo_spans').select('*')).error).toBeTruthy();
 expect((await anon.rpc('record_photo_timing_spans',{p_analysis_id:f.analysisId,p_run_id:f.job.runId,p_job_id:f.job.id,p_worker_id:'photo-test',p_job_lease_attempt:f.job.attempts,p_spans:[f.row]})).error).toBeTruthy();
 const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({role:'authenticated',sub:randomUUID(),aud:'authenticated',exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
 const signature=createHmac('sha256',values.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
 const authenticated=createClient(values.API_URL,values.ANON_KEY,{auth:{persistSession:false,storageKey:'photo-authenticated-test'},global:{headers:{Authorization:`Bearer ${header}.${payload}.${signature}`}}});
 const control=await authenticated.from('analyses').select('id').eq('id',f.analysisId);
 expect(control.error).toBeNull();
 expect(control.data).toEqual([]);
 expect((await authenticated.from('diagnostic_photo_spans').select('*')).error?.code).toBe('42501');
 expect((await authenticated.rpc('record_photo_timing_spans',{p_analysis_id:f.analysisId,p_run_id:f.job.runId,p_job_id:f.job.id,p_worker_id:'photo-test',p_job_lease_attempt:f.job.attempts,p_spans:[f.row]})).error).toBeTruthy();
 await client.from('analyses').delete().eq('id',f.analysisId);
 expect((await client.from('diagnostic_photo_spans').select('id').eq('id',f.row.id)).data).toEqual([]);
});
it('rejects cross-analysis parents even when evidence and lease are valid',async()=>{
 const a=await fixture(),b=await fixture();
 expect((await a.write([a.row])).error).toBeNull();
 expect((await b.write([{...b.row,parentId:a.row.id}])).error).toBeTruthy();
});
it('retains omission counts without replacing a completed phase',async()=>{
 const f=await fixture();
 const row={...f.row,state:'complete',completedAt:f.row.startedAt,durationMs:2};
 expect((await f.write([row])).error).toBeNull();
 expect((await f.write([{...f.row,omittedCount:3}])).error).toBeNull();
 const result=await client.from('diagnostic_photo_spans').select('state,duration_ms,omitted_count').eq('id',row.id).single();
 expect(result.data).toEqual({state:'complete',duration_ms:2,omitted_count:3});
});
