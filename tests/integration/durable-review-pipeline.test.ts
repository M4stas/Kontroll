import {AnalysisReportSchema} from '@/domain/schemas';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {getBackgroundCheck,saveBackgroundCheck,reconcileBackgroundCheck,getBackgroundCheckWithText} from '@/server/repositories/background-checks';
import {AnalysisUploads} from '@/server/storage/uploads';
import {issueInsightImageCapability} from '@/insights/image-capability';
import {execFileSync} from 'node:child_process';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {afterEach,beforeAll,expect,it} from 'vitest';
import {createStageHandlers} from '@/analysis/pipeline';
import {AnalysesRepository} from '@/server/repositories/analyses';
import {EvidenceRepository} from '@/server/repositories/evidence';
import {JobsRepository} from '@/server/repositories/jobs';
import {ReviewExecutionsRepository} from '@/server/repositories/review-executions';
import {createAccessToken} from '@/server/access/tokens';
import {processJob} from '@/worker/process-job';
import type {ReviewResult,ReviewInput} from '@/insights/types';
let client:SupabaseClient;const created:string[]=[];const uploaded:Array<{id:string;key:string}>=[];
beforeAll(()=>{
 const output=(process.env.SUPABASE_CLI_ENTRY
   ? execFileSync(process.execPath, [process.env.SUPABASE_CLI_ENTRY, "status", "-o", "env"], { encoding: "utf8" })
   : execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" }));
 const values=Object.fromEntries(output.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),JSON.parse(line.slice(i+1))];}));
 client=createClient(values.API_URL,values.SERVICE_ROLE_KEY??values.SECRET_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
});
afterEach(async()=>{for(const image of uploaded)await new AnalysisUploads(client).remove(image.id,[image.key]);uploaded.length=0;for(const id of created)await client.from('analyses').delete().eq('id',id);created.length=0;});
const capabilities={responses:true,text:true,structuredOutput:true,imageInput:true,efforts:[]};
async function fixture(disabled=false, pastedText="Toyota Avensis 2017"){
 const analyses=new AnalysesRepository(client);const evidence=new EvidenceRepository(client);const jobs=new JobsRepository(client);const executions=new ReviewExecutionsRepository(client);
 const {publicId}=await analyses.create({accessTokenHash:createAccessToken().hash,locale:'et',listingUrl:'https://example.test/manual',inputType:'pasted_text',pastedText});
 const id=await analyses.loadAnalysisId(publicId);if(!id)throw Error('Fixture missing');created.push(id);
 const calls:ReviewInput[]=[];const failures={final:false,imageContext:false,aggregate:false};const hooks:{imageAccessBlocked?:boolean;imageAccesses?:number;onReview?:(input:ReviewInput)=>Promise<void>;commitError?:unknown;reviewResult?:(input:ReviewInput)=>ReviewResult}={};
 const commit=executions.commitAttempt.bind(executions);executions.commitAttempt=async(...args)=>{try{return await commit(...args);}catch(error){hooks.commitError=error instanceof Error?error.cause:error;throw error;}};
 const environment=disabled?{DATA_REVIEW_ENABLED:'false'}:{OPENAI_API_KEY:'fixture-only',DATA_REVIEW_MODEL:'fixture-model',DATA_REVIEW_CAPABILITIES:JSON.stringify({openai:{'fixture-model':capabilities}})};
 const stages=createStageHandlers({analyses,evidence,reviewExecutions:executions,getBackgroundCheck:id=>getBackgroundCheckWithText(id,client),workerId:'durable-fixture-worker',
  listingAdapter:{canHandle:()=>true,capture:async()=>{throw Error('Manual input must never capture');}},
  insightEnvironment:environment,
  reviewImageCapability:async(analysisId,evidenceId,key,hash)=>{hooks.imageAccesses=(hooks.imageAccesses??0)+1;if(hooks.imageAccessBlocked)throw Error('Fixture image access blocked');const uploads=new AnalysisUploads(client);if(await uploads.getStoredContentHash(analysisId,key)!==hash)throw Error('changed');return issueInsightImageCapability({analysisId,evidenceId,storageKey:key,...await uploads.createSignedRead(analysisId,key)},'integration-fixture-secret-at-least-32');},
  dataReviewer:()=>({review:async input=>{calls.push(input);await hooks.onReview?.(input);if(hooks.reviewResult)return hooks.reviewResult(input);return {schemaVersion:1,observations:failures.aggregate?Array.from({length:input.pass==='final'?1:64},(_,index)=>({id:`${input.pass}-${index}`,evidenceIds:[input.imageEvidenceId??input.evidence[0]!.id],category:'context',title:`${input.pass} ${input.imageEvidenceId?.slice(0,8)??'text'} ${index}`,severity:'context' as const,explanation:'Inspect.',recommendedAction:{kind:'inspection_task' as const,title:'Inspect',instructions:'Inspect.'},confidence:0.6})):input.pass==='image'&&failures.imageContext?[{id:'image-context',evidenceIds:[input.imageEvidenceId!,input.evidence.find(item=>item.id!==input.imageEvidenceId)!.id],category:'visible_condition',title:'Visible concern requires inspection',severity:'context' as const,explanation:'Interpret image with the supplied buyer context.',recommendedAction:{kind:'inspection_task' as const,title:'Inspect in person',instructions:'Confirm the concern in person. '+ 'x'.repeat(6000)},confidence:0.6}]:[],warnings:input.pass==='final'&&failures.final?[{code:'timeout' as const,message:'Fixture timeout.'}]:[]};}}),
 });
 const drain=async()=>{for(let i=0;i<12;i++){const job=await jobs.leaseForAnalysis('durable-fixture-worker',60,id);if(!job)return;await processJob(job,{workerId:'durable-fixture-worker',jobs,stages});}throw Error('Pipeline did not settle');};
 return {analyses,jobs,executions,id,publicId,calls,drain,failures,environment,hooks,stages};
}
it('publishes one final assessment after durable text commit and skips absent images',async()=>{
 const f=await fixture();await f.drain();
 expect(f.calls.map(input=>input.pass)).toEqual(['text','final']);
 expect(f.calls[0]?.sourceRecords).toContainEqual(expect.objectContaining({kind:'buyer_note',content:'Toyota Avensis 2017'}));
 const report=await f.analyses.loadReport(f.publicId);expect(report?.status).toBe('complete');expect(report?.review).toMatchObject({state:'complete',text:'complete',images:{supplied:0,selected:0,complete:0},final:'complete'});
 const {data:analysis}=await client.from('analyses').select('current_run_id').eq('id',f.id).single();
 const executions=await f.executions.loadExecutions(f.id,analysis!.current_run_id);
 expect(executions).toHaveLength(2);expect(executions.every(execution=>execution.resultHash)).toBe(true);
 expect(f.calls[1]?.priorReviews?.[0]?.executionId).toBe(executions.find(execution=>execution.pass==='text')?.id);
 expect(await f.jobs.retryCurrentReview(f.id)).toBe(false);
});
it('keeps developer-disabled review explicitly baseline only without provider calls',async()=>{
 const f=await fixture(true);await f.drain();
 expect(f.calls).toHaveLength(0);const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');expect(report?.review?.state).toBe('disabled');
});

it('reuses committed text while retrying a failed final assessment',async()=>{
 const f=await fixture();f.failures.final=true;await f.drain();
 expect((await f.analyses.loadReport(f.publicId))?.review?.state).toBe('incomplete');
 expect(await f.jobs.retryCurrentReview(f.id)).toBe(true);
 f.failures.final=false;
 await client.from('analysis_jobs').update({available_at:'2000-01-01T00:00:00.000Z'}).eq('analysis_id',f.id).eq('stage','enrich').eq('status','queued');
 await f.drain();expect(f.calls.map(input=>input.pass)).toEqual(['text','final','final']);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});
it('reviews each private supplied image and finalizes only after its durable result',async()=>{
 const f=await fixture();await f.drain();
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#444'}}).png().toBuffer();
 const stored=await new AnalysisUploads(client).upload(f.id,{name:'image.png',type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
 uploaded.push({id:f.id,key:stored.storageKey});
 await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'image',providedBy:'buyer',storageKey:stored.storageKey,mimeType:stored.mimeType}],stages:['enrich','assemble_report']});
 f.calls.length=0;f.failures.imageContext=true;await f.drain();expect(f.calls.map(input=>input.pass)).toEqual(['text','image','final']);
 expect(f.calls[1]?.images).toHaveLength(1);expect(f.calls[2]?.priorReviews?.map(review=>review.pass)).toEqual(['text','image']);
 const report=await f.analyses.loadReport(f.publicId);expect(report?.review?.images).toMatchObject({supplied:1,selected:1,complete:1,unavailable:0});
 expect(report?.actions.find(action=>action.title==='Inspect in person')?.instructions).toHaveLength(6031);
 const imageId=f.calls[1]!.imageEvidenceId!;
 const evidence=report!.evidence.find(item=>item.id===imageId)!;
 expect(evidence.imageUrl).toBe(`/api/analyses/${f.publicId}/images/${imageId}`);
 expect(evidence.sourceUrl).toBeUndefined();
 expect(report!.review!.images.items).toContainEqual({evidenceId:imageId,state:'complete'});
 const source=await f.analyses.loadImageSource(f.publicId,imageId);
 expect(source?.storageKey).toBe(stored.storageKey);
 const read=await new AnalysisUploads(client).readImage(source!.analysisId,source!.storageKey!,source!.contentHash);
 expect(read.mimeType).toBe('image/png');
 const foreign=await fixture();
 expect(await foreign.analyses.loadImageSource(foreign.publicId,imageId)).toBeNull();

});
it('bounds image reviews at three and publishes once after out-of-order durable commits',async()=>{
 const f=await fixture();await f.drain();
 const submissions=[];
 for(let index=0;index<4;index++){
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:{r:30+index*40,g:20,b:30}}}).png().toBuffer();
  const stored=await new AnalysisUploads(client).upload(f.id,{name:`bounded-${index}.png`,type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
  uploaded.push({id:f.id,key:stored.storageKey});submissions.push({kind:'image' as const,providedBy:'buyer' as const,storageKey:stored.storageKey,mimeType:stored.mimeType});
 }
 const {runId}=await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions,stages:['enrich','assemble_report']});
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
 const starts=Array.from({length:4},deferred);const completed=Array.from({length:4},deferred);
 const releases=new Map<string,ReturnType<typeof deferred>>();const startOrder:string[]=[];const persistedCounts:number[]=[];
 let active=0;let peak=0;let publications=0;
 const saveProgress=f.executions.saveProgress.bind(f.executions);
 f.executions.saveProgress=async(...args)=>{
  await saveProgress(...args);
  const {data:run,error}=await client.from('analysis_runs').select('stage_states').eq('id',runId).single();
  expect(error).toBeNull();
  const review=run!.stage_states.enrich.output.review;
  expect(review).toEqual((args[1].output as {review:unknown}).review);
  expect(review.images.complete).toBe(review.images.items.filter((item:{state:string})=>item.state==='complete').length);
  persistedCounts.push(review.images.complete);
  if(review.images.complete>0)completed[review.images.complete-1]!.resolve();
 };
 const commit=f.executions.commitAttempt.bind(f.executions);
 f.executions.commitAttempt=async(...args)=>{await commit(...args);if(args[2].publication)publications++;};
 f.hooks.onReview=async input=>{
  if(input.pass==='image'){
   const gate=deferred();releases.set(input.imageEvidenceId!,gate);startOrder.push(input.imageEvidenceId!);
   active++;peak=Math.max(peak,active);starts[startOrder.length-1]!.resolve();
   try{await gate.promise;}finally{active--;}
  }
  if(input.pass==='final'){
   const executions=await f.executions.loadExecutions(f.id,runId);
   expect(executions.filter(execution=>execution.pass==='image'&&execution.resultHash)).toHaveLength(4);
   expect(publications).toBe(0);
  }
 };
 f.calls.length=0;
 const draining=f.drain();
 // This watchdog only bounds broken implementations; ordering is driven by explicit gates.
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 const stalled=new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(Error('Controlled image review did not advance')),10_000);});
 const waitFor=(signal:Promise<void>)=>Promise.race([signal,stalled,draining.then(()=>{throw Error('Pipeline settled before the expected image event');})]);
 try{
  await waitFor(starts[2]!.promise);
  expect(startOrder).toHaveLength(3);expect(active).toBe(3);expect(publications).toBe(0);
  expect(f.calls.filter(input=>input.pass==='final')).toHaveLength(0);
  const snapshot=await f.executions.loadSnapshot(f.id,runId);expect(snapshot).not.toBeNull();
  const canonicalIds=snapshot!.imageManifest.images.filter(image=>image.selected).map(image=>image.evidenceId);
  releases.get(startOrder[1]!)!.resolve();
  await waitFor(starts[3]!.promise);
  expect(active).toBe(3);expect(peak).toBe(3);
  const firstCommits=await f.executions.loadExecutions(f.id,runId);
  expect(firstCommits.filter(execution=>execution.pass==='image'&&execution.resultHash).map(execution=>execution.imageEvidenceId)).toEqual([startOrder[1]]);
  expect(f.calls.filter(input=>input.pass==='final')).toHaveLength(0);
  releases.get(startOrder[3]!)!.resolve();await waitFor(completed[1]!.promise);
  releases.get(startOrder[0]!)!.resolve();await waitFor(completed[2]!.promise);
  expect(f.calls.filter(input=>input.pass==='final')).toHaveLength(0);expect(publications).toBe(0);
  releases.get(startOrder[2]!)!.resolve();await draining;
  expect(peak).toBe(3);expect(active).toBe(0);expect(publications).toBe(1);
  const finalCalls=f.calls.filter(input=>input.pass==='final');expect(finalCalls).toHaveLength(1);
  expect(finalCalls[0]!.priorReviews?.map(review=>review.pass)).toEqual(['text','image','image','image','image']);
  expect(finalCalls[0]!.priorReviews?.filter(review=>review.pass==='image').map(review=>review.imageEvidenceId)).toEqual(canonicalIds);
  expect(persistedCounts).toEqual([...persistedCounts].sort((left,right)=>left-right));
  expect([...new Set(persistedCounts)]).toEqual([0,1,2,3,4]);
  const executions=await f.executions.loadExecutions(f.id,runId);
  expect(executions).toHaveLength(6);expect(executions.every(execution=>execution.resultHash)).toBe(true);
  const report=await f.analyses.loadReport(f.publicId);
  expect(report?.status).toBe('complete');expect(report?.review).toMatchObject({state:'complete',images:{supplied:4,selected:4,complete:4,unavailable:0},final:'complete'});
 }finally{
  if(watchdog)clearTimeout(watchdog);
  // Release any blocked providers before the fixture removes their durable records.
  f.hooks.onReview=undefined;for(const gate of releases.values())gate.resolve();await draining;
 }
});

it('reuses actual committed image results on final retry without accessing storage',async()=>{
 const f=await fixture();await f.drain();
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#555'}}).png().toBuffer();
 const stored=await new AnalysisUploads(client).upload(f.id,{name:'cached.png',type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
 uploaded.push({id:f.id,key:stored.storageKey});
 await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'image',providedBy:'buyer',storageKey:stored.storageKey,mimeType:stored.mimeType}],stages:['enrich','assemble_report']});
 f.failures.final=true;f.calls.length=0;await f.drain();
 expect(f.calls.map(input=>input.pass)).toEqual(['text','image','final']);
 const accesses=f.hooks.imageAccesses;
 f.hooks.imageAccessBlocked=true;f.failures.final=false;f.calls.length=0;
 expect(await f.jobs.retryCurrentReview(f.id)).toBe(true);
 expect((await client.from('analysis_jobs').update({available_at:'2000-01-01T00:00:00.000Z'}).eq('analysis_id',f.id).eq('stage','enrich').eq('status','queued')).error).toBeNull();
 await f.drain();
 expect(f.hooks.imageAccesses).toBe(accesses);
 expect(f.calls.map(input=>input.pass)).toEqual(['final']);
 expect(f.calls[0]?.priorReviews?.map(review=>review.pass)).toEqual(['text','image']);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});

it('developer rereview keeps the private URL and pins fresh settings on a child run',async()=>{
 const f=await fixture();await f.drain();
 const {data:before}=await client.from('analyses').select('current_run_id').eq('id',f.id).single();
 const runId=await f.analyses.developerRereview(f.id);expect(runId).not.toBe(before!.current_run_id);
 f.environment.DATA_REVIEW_MODEL='new-fixture-model';f.environment.DATA_REVIEW_CAPABILITIES=JSON.stringify({openai:{'new-fixture-model':capabilities}});
 await f.drain();const pinned=await f.executions.loadSnapshot(f.id,runId);
 expect(pinned?.passes.text.model).toBe('new-fixture-model');expect((await f.analyses.loadReport(f.publicId))?.publicId).toBe(f.publicId);
});

it('exhausted final retries preserve an incomplete baseline report instead of finalizing',async()=>{
 const f=await fixture();f.failures.final=true;await f.drain();
 const {error}=await client.from('analysis_jobs').update({attempts:3,available_at:'2000-01-01T00:00:00.000Z'}).eq('analysis_id',f.id).eq('stage','enrich').eq('status','queued');expect(error).toBeNull();
 await f.drain();const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('partial');expect(report?.review?.state).toBe('incomplete');expect(report?.review?.final).toBe('unavailable');
 const {data:job}=await client.from('analysis_jobs').select('attempts,status').eq('analysis_id',f.id).eq('stage','enrich').single();expect(job).toMatchObject({attempts:4,status:'failed'});
});
it('manual retry closes orphaned attempts before resetting its retry budget',async()=>{
 const f=await fixture();f.failures.final=true;await f.drain();
 await client.from('analysis_jobs').update({available_at:'2000-01-01T00:00:00.000Z'}).eq('analysis_id',f.id).eq('stage','enrich').eq('status','queued');
 const job=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);if(!job)throw Error('Expected scoped enrich retry');
 const lease={analysisId:f.id,runId:job.runId,jobId:job.id,workerId:'durable-fixture-worker'};
 const execution=(await f.executions.loadExecutions(f.id,job.runId)).find(item=>item.pass==='final');if(!execution)throw Error('Expected final execution');
 const orphan=await f.executions.startAttempt(lease,execution.id);
 await f.jobs.fail(job.id,lease.workerId,'fixture_failure');expect(await f.jobs.retryCurrentReview(f.id)).toBe(true);
 const {data:attempt}=await client.from('review_attempts').select('state,warning_code').eq('id',orphan.id).single();expect(attempt).toMatchObject({state:'lost',warning_code:'manual_retry'});
 f.failures.final=false;await f.drain();expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});

it('superseding a live review does not publish its stale result or stop the worker',async()=>{
 const f=await fixture();let superseded=false;let oldRun='';
 f.hooks.onReview=async input=>{if(!superseded){superseded=true;oldRun=input.runId;await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'seller_answer',providedBy:'seller',textContent:'Updated service evidence is still unverified.'}],stages:['enrich','assemble_report']});}};
 await expect(f.drain()).resolves.toBeUndefined();
 const old=await f.executions.loadExecutions(f.id,oldRun);expect(old.some(execution=>execution.pass==='final')).toBe(false);expect(old[0]?.result).toBeNull();
 expect(f.calls.map(input=>input.pass)).toEqual(['text','text','final']);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});

it('rejects a stale artifact replacement after a previously absent snapshot is finalized',async()=>{
 const f=await fixture();
 const {data:initial}=await client.from('analyses').select('current_run_id').eq('id',f.id).single();
 expect(await f.executions.loadSnapshot(f.id,initial!.current_run_id)).toBeNull();
 await f.drain();const before=await f.analyses.loadReport(f.publicId);expect(before?.findings.length).toBeGreaterThan(0);
 const evidence=new EvidenceRepository(client);
 await expect(evidence.saveFindings([],{analysisId:f.id,runId:initial!.current_run_id})).rejects.toThrow();
 await expect(evidence.saveActions([],{analysisId:f.id,runId:initial!.current_run_id})).rejects.toThrow();
 const after=await f.analyses.loadReport(f.publicId);expect(after?.findings).toEqual(before?.findings);expect(after?.actions).toEqual(before?.actions);
});

it.each([3,15])('publishes all admitted observations from %i images without truncating the aggregate',async(imageCount)=>{
 const f=await fixture();await f.drain();
 const submissions=[];
 for(let index=0;index<imageCount;index++){
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:{r:index*10,g:20,b:30}}}).png().toBuffer();
  const stored=await new AnalysisUploads(client).upload(f.id,{name:`image-${index}.png`,type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
  uploaded.push({id:f.id,key:stored.storageKey});submissions.push({kind:'image' as const,providedBy:'buyer' as const,storageKey:stored.storageKey,mimeType:stored.mimeType});
 }
 for(let offset=0;offset<submissions.length;offset+=8){await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:submissions.slice(offset,offset+8),stages:['enrich','assemble_report']});if(offset+8<submissions.length)await f.drain();}
 f.failures.aggregate=true;f.calls.length=0;await f.drain();
 const report=await f.analyses.loadReport(f.publicId);
 if(report?.status!=='complete'){const diagnostic=await client.from('analysis_jobs').select('stage,status,last_error').eq('analysis_id',f.id);throw Error(JSON.stringify({calls:f.calls.map(input=>input.pass),jobs:diagnostic.data,commitError:f.hooks.commitError}));}
 expect(report?.status).toBe('complete');
 const agentFindings=report?.findings.filter(finding=>finding.origin==='agent')??[];
 expect(agentFindings).toHaveLength(64*(imageCount+1)+1);expect(agentFindings.every(finding=>finding.evidenceIds.length===1)).toBe(true);
 expect(report?.actions.filter(action=>agentFindings.some(finding=>finding.id===action.findingId))).toHaveLength(64*(imageCount+1)+1);
 expect(f.calls.map(input=>input.pass)).toEqual(['text',...Array.from({length:imageCount},()=> 'image'),'final']);
});

it('retains original evidence ownership when two image groups supersede before enrich',async()=>{
 const f=await fixture();await f.drain();
 const groups=[];
 for(let index=0;index<2;index++){
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:{r:index*50,g:20,b:30}}}).png().toBuffer();
  const stored=await new AnalysisUploads(client).upload(f.id,{name:`rapid-${index}.png`,type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
  uploaded.push({id:f.id,key:stored.storageKey});
  groups.push(await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'image',providedBy:'buyer',storageKey:stored.storageKey,mimeType:stored.mimeType}],stages:['enrich','assemble_report']}));
 }
 f.failures.aggregate=true;f.calls.length=0;await f.drain();
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');
 expect(report?.review?.images).toMatchObject({supplied:2,selected:2,complete:2,unavailable:0});
 expect(f.calls.map(input=>input.pass)).toEqual(['text','image','image','final']);
 const imageIds=f.calls.filter(input=>input.pass==='image').map(input=>input.imageEvidenceId!);
 const {data:rows,error}=await client.from('evidence').select('id,run_id').eq('analysis_id',f.id).in('id',imageIds);
 expect(error).toBeNull();expect(rows).toHaveLength(2);
 expect(rows?.map(row=>row.run_id).sort()).toEqual(groups.map(group=>group.runId).sort());
 const {data:links,error:linkError}=await client.from('finding_evidence').select('evidence_id').in('evidence_id',imageIds);
 expect(linkError).toBeNull();expect(new Set(links?.map(link=>link.evidence_id))).toEqual(new Set(imageIds));
 const {data:oldJobs}=await client.from('analysis_jobs').select('status,last_error').eq('analysis_id',f.id).eq('run_id',groups[0]!.runId);
 expect(oldJobs?.every(job=>job.status==='failed'&&job.last_error?.code==='superseded')).toBe(true);
});

it('reruns baseline with original capture and supplement ownership after rapid text and images',async()=>{
 const f=await fixture();await f.drain();
 const {data:originalCapture}=await client.from('evidence').select('id,run_id').eq('analysis_id',f.id).eq('claim','Toyota Avensis 2017');
 expect(originalCapture?.length).toBeGreaterThan(0);
 await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'buyer_note',providedBy:'buyer',textContent:'Service history is unverified.'}],stages:['baseline_checks','enrich','assemble_report']});
 const groups=[];
 for(let index=0;index<2;index++){
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:{r:index*50,g:20,b:30}}}).png().toBuffer();
  const stored=await new AnalysisUploads(client).upload(f.id,{name:`rapid-${index}.png`,type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
  uploaded.push({id:f.id,key:stored.storageKey});
  groups.push(await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'image',providedBy:'buyer',storageKey:stored.storageKey,mimeType:stored.mimeType}],stages:['baseline_checks','enrich','assemble_report']}));
 }
 f.failures.aggregate=true;f.calls.length=0;await f.drain();
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');
 const {data:retainedCapture}=await client.from('evidence').select('id,run_id').eq('analysis_id',f.id).in('id',originalCapture!.map(item=>item.id));
 expect(retainedCapture).toEqual(originalCapture);
 const admittedIds=report!.evidence.map(item=>item.id);
 const {data:admittedRows,error:admittedError}=await client.from('evidence').select('id').eq('analysis_id',f.id).in('id',admittedIds);
 expect(admittedError).toBeNull();expect(new Set(admittedRows?.map(item=>item.id))).toEqual(new Set(admittedIds));
 expect(report?.review?.images).toMatchObject({supplied:2,selected:2,complete:2,unavailable:0});
 expect(f.calls.map(input=>input.pass)).toEqual(['text','image','image','final']);
 const imageIds=f.calls.filter(input=>input.pass==='image').map(input=>input.imageEvidenceId!);
 const {data:rows,error}=await client.from('evidence').select('id,run_id').eq('analysis_id',f.id).in('id',imageIds);
 expect(error).toBeNull();expect(rows).toHaveLength(2);
 expect(rows?.map(row=>row.run_id).sort()).toEqual(groups.map(group=>group.runId).sort());
 const {data:links,error:linkError}=await client.from('finding_evidence').select('evidence_id').in('evidence_id',imageIds);
 expect(linkError).toBeNull();expect(new Set(links?.map(link=>link.evidence_id))).toEqual(new Set(imageIds));
 const {data:oldJobs}=await client.from('analysis_jobs').select('status,last_error').eq('analysis_id',f.id).eq('run_id',groups[0]!.runId);
 expect(oldJobs?.every(job=>job.status==='failed'&&job.last_error?.code==='superseded')).toBe(true);
});


it('keeps captured listing photos reviewable after a seller answer reruns baseline',async()=>{
 const f=await fixture();
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#666'}}).png().toBuffer();
 const stored=await new AnalysisUploads(client).upload(f.id,{name:'listing.png',type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
 uploaded.push({id:f.id,key:stored.storageKey});
 const capture={type:'snapshot',marketplace:'auto24',sourceId:crypto.randomUUID(),sourceUrl:'https://www.auto24.ee/vehicles/fixture',capturedAt:new Date().toISOString(),contentHash:'a'.repeat(64),description:'Toyota Avensis 2017; panel marks visible.',facts:[{key:'make',value:'Toyota',sourceId:'fixture',verification:'unverified',confidence:0.5},{key:'model',value:'Avensis',sourceId:'fixture',verification:'unverified',confidence:0.5}],claims:[],imageUrls:['https://img.auto24.ee/listing.png'],screenshotRefs:[],warnings:[],sourceRecords:[{evidenceId:'listing-text',sourceId:'fixture',kind:'listing_text',content:'Toyota Avensis 2017; panel marks visible.',verification:'unverified'}],photoPreparation:{version:1,counts:{supplied:1,selected:1,accepted:1,skipped:0,rejected:0,unavailable:0},images:[{index:0,evidenceId:'listing-photo',status:'accepted',storageKey:stored.storageKey,contentHash:stored.contentHash,mimeType:stored.mimeType}]}};
 expect((await client.from('analysis_inputs').update({capture_snapshot:capture}).eq('analysis_id',f.id)).error).toBeNull();
 await f.drain();
 expect((await f.analyses.loadReport(f.publicId))?.review?.images.complete).toBe(1);
 const child=await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'seller_answer',providedBy:'seller',textContent:'Panel marks are surface staining; no service invoices.'}],stages:['baseline_checks','enrich','assemble_report']});
 let liveImageUrl:string|undefined;
 f.hooks.onReview=async input=>{if(input.pass==='image'){const live=await f.analyses.loadReport(f.publicId);liveImageUrl=live?.evidence.find(item=>item.id===input.imageEvidenceId)?.imageUrl;}};
 f.calls.length=0;await f.drain();
 expect(liveImageUrl).toMatch(/^\/api\/analyses\/.+\/images\//);
 const pinned=await f.executions.loadSnapshot(f.id,child.runId);
 expect(pinned).not.toBeNull();
 expect(pinned?.input.sourceRecords).toContainEqual(expect.objectContaining({kind:'seller_reply',content:'Panel marks are surface staining; no service invoices.'}));
 expect(f.calls.map(input=>input.pass)).toEqual(['text','image','final']);
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');expect(report?.publicId).toBe(f.publicId);
 expect(report?.review?.images).toMatchObject({supplied:1,complete:1,unavailable:0});
 const photoId=f.calls.find(input=>input.pass==='image')!.imageEvidenceId!;
 expect(report?.evidence.find(item=>item.id===photoId)?.imageUrl).toBe(`/api/analyses/${f.publicId}/images/${photoId}`);
 expect(await f.analyses.loadImageSource(f.publicId,photoId)).toMatchObject({storageKey:stored.storageKey});
 const validation=await f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'seller_answer',providedBy:'seller',textContent:'Validate retained photo ownership.'}],stages:['enrich','assemble_report']});
 const validationJob=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);expect(validationJob?.stage).toBe('enrich');
 const lease={analysisId:f.id,runId:validation.runId,jobId:validationJob!.id,workerId:'durable-fixture-worker'};
 const draft={analysisId:f.id,runId:validation.runId,locale:pinned!.locale,preparationVersion:pinned!.preparationVersion,schemaVersion:pinned!.schemaVersion,mode:pinned!.mode,input:pinned!.input,imageManifest:pinned!.imageManifest,passes:pinned!.passes};
 for(const changed of [{contentHash:'b'.repeat(64)},{storageKey:`${f.id}/other.png`},{mimeType:'image/jpeg' as const}]){
  await expect(f.executions.pinRunSnapshot(lease,{...draft,imageManifest:{...draft.imageManifest,images:draft.imageManifest.images.map(image=>({...image,...changed}))}})).rejects.toMatchObject({cause:{message:'accepted review images require selected analysis-owned bytes and a content hash'}});
 }
 const {data:childRow}=await client.from('analysis_runs').select('parent_run_id,stage_states').eq('id',child.runId).single();
 const sibling=await client.from('analysis_runs').insert({analysis_id:f.id,parent_run_id:childRow!.parent_run_id,trigger:'supplement',stage_states:{}}).select('id').single();expect(sibling.error).toBeNull();
 const originalPhotoId=childRow!.stage_states.capture_listing.output.snapshot.photoPreparation.images[0].evidenceId;
 const hash=createHash('sha256').update(`${f.id}:${sibling.data!.id}:capture-citation:${originalPhotoId}`).digest('hex');
 const siblingCitation=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-${((parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
 const {data:photoRow}=await client.from('evidence').select('*').eq('id',photoId).single();
 expect((await client.from('evidence').insert({...photoRow,id:siblingCitation,run_id:sibling.data!.id})).error).toBeNull();
 await expect(f.executions.pinRunSnapshot(lease,{...draft,imageManifest:{...draft.imageManifest,images:draft.imageManifest.images.map(image=>({...image,evidenceId:siblingCitation}))}})).rejects.toMatchObject({cause:{message:'accepted review images require selected analysis-owned bytes and a content hash'}});
 await expect(f.executions.pinRunSnapshot(lease,draft)).resolves.toMatchObject({runId:validation.runId});

});

it('developer rereview carries unfinished research into the new run',async()=>{
 const f=await fixture();
 for(let index=0;index<3;index++){
  const job=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);expect(job).not.toBeNull();
  await processJob(job!,{workerId:'durable-fixture-worker',jobs:f.jobs,stages:f.stages});
 }
 const runId=await f.analyses.developerRereview(f.id);
 const job=await f.jobs.leaseForAnalysis('rereview-pending-research',60,f.id);
 expect(job?.runId).toBe(runId);expect(job?.stage).toBe('research');
 await f.jobs.retry(job!.id,'rereview-pending-research',new Date(0),'fixture relinquish');
 await f.drain();expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});

it.each(['unavailable','rejected'])('developer rereview resets capture only for transient %s photos and preserves the parent audit',async(status)=>{
 const f=await fixture();await f.drain();
 const {data:parent}=await client.from('analyses').select('current_run_id').eq('id',f.id).single();
 const parentId=parent!.current_run_id;
 const pinned=await f.executions.loadSnapshot(f.id,parentId);
 const {data:run}=await client.from('analysis_runs').select('stage_states').eq('id',parentId).single();
 const states=run!.stage_states;
 const capturedInput={...states.capture_listing.output.snapshot,imageUrls:['https://img.auto24.ee/fixture-original.jpg']};
 expect((await client.from('analysis_inputs').update({capture_snapshot:capturedInput}).eq('analysis_id',f.id)).error).toBeNull();
 states.capture_listing.output.snapshot.photoPreparation={version:1,counts:{supplied:1,selected:1,accepted:0,skipped:0,rejected:status==='rejected'?1:0,unavailable:status==='unavailable'?1:0},images:[{index:0,evidenceId:'fixture-photo',status}]};
 expect((await client.from('analysis_runs').update({stage_states:states}).eq('id',parentId)).error).toBeNull();
 const childId=await f.analyses.developerRereview(f.id);
 const {data:child}=await client.from('analysis_runs').select('stage_states,parent_run_id').eq('id',childId).single();
 expect(child?.parent_run_id).toBe(parentId);
 const job=await f.jobs.leaseForAnalysis('photo-recovery-fixture',60,f.id);
 expect(job?.runId).toBe(childId);expect(job?.stage).toBe(status==='unavailable'?'capture_listing':'enrich');
 if(status==='unavailable')expect(child?.stage_states).toEqual({});
 else expect(child?.stage_states.capture_listing).toEqual(states.capture_listing);
 const {data:retained}=await client.from('analysis_runs').select('stage_states').eq('id',parentId).single();
 expect(retained?.stage_states).toEqual(states);
 expect(await f.executions.loadSnapshot(f.id,parentId)).toEqual(pinned);
 await f.jobs.retry(job!.id,'photo-recovery-fixture',new Date(0),'fixture relinquish');
 await f.drain();expect((await f.analyses.loadReport(f.publicId))?.status).toBe(status==='unavailable'?'complete':'partial');
 if(status==='unavailable'){
  const {data:completedChild}=await client.from('analysis_runs').select('stage_states').eq('id',childId).single();
  expect(completedChild?.stage_states.capture_listing.output.snapshot.imageUrls).toEqual(capturedInput.imageUrls);
 }
});

it('loads report facts, sources and evidence beyond the gateway row cap',async()=>{
 const f=await fixture();
 const {data:analysis}=await client.from('analyses').select('current_run_id').eq('id',f.id).single();
 const runId=analysis!.current_run_id;
 const sources=Array.from({length:1025},()=>({id:crypto.randomUUID(),analysis_id:f.id,run_id:runId,source_type:'listing',extraction_status:'complete',source_url:'https://example.test/source'}));
 const evidenceRows=sources.map((source,index)=>({id:crypto.randomUUID(),analysis_id:f.id,run_id:runId,source_snapshot_id:source.id,source_class:'listing',claim:`Claim ${index}`,applicability:'Unverified',confidence:0.5,verification:'unverified'}));
 const facts=sources.map((source,index)=>({id:crypto.randomUUID(),analysis_id:f.id,run_id:runId,source_snapshot_id:source.id,fact_key:`fact-${index}`,fact_value:String(index),match_confidence:0.5,verification:'unverified'}));
 for(let offset=0;offset<sources.length;offset+=500){
  expect((await client.from('source_snapshots').insert(sources.slice(offset,offset+500))).error).toBeNull();
  expect((await client.from('evidence').insert(evidenceRows.slice(offset,offset+500))).error).toBeNull();
  expect((await client.from('vehicle_facts').insert(facts.slice(offset,offset+500))).error).toBeNull();
 }
 expect((await client.from('analysis_runs').update({stage_states:{normalize_identity:{version:1,status:'complete'},baseline_checks:{version:1,status:'complete',output:{evidence:evidenceRows.map(row=>({id:row.id}))}},assemble_report:{version:1,status:'complete',output:{evidenceIds:evidenceRows.map(row=>row.id)}}}}).eq('id',runId)).error).toBeNull();
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.vehicleFacts).toHaveLength(1025);expect(report?.evidence).toHaveLength(1025);expect(Object.keys(report?.sources??{})).toHaveLength(1025);
});

async function addPdf(f:Awaited<ReturnType<typeof fixture>>,label='history'){
 return f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'document',providedBy:'buyer',storageKey:`${f.id}/${crypto.randomUUID()}.pdf`,mimeType:'application/pdf',textContent:`Page 1: ${label}`}],stages:['enrich','assemble_report']});
}
async function addPhoto(f:Awaited<ReturnType<typeof fixture>>){
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#777'}}).png().toBuffer();
 const stored=await new AnalysisUploads(client).upload(f.id,{name:'pdf-parent.png',type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
 uploaded.push({id:f.id,key:stored.storageKey});
 return f.jobs.enqueueMany({analysisId:f.id,idempotencyKey:crypto.randomUUID(),submissions:[{kind:'image',providedBy:'buyer',storageKey:stored.storageKey,mimeType:stored.mimeType}],stages:['enrich','assemble_report']});
}
it('PDF children and chained PDFs reuse completed text and photo results and call only final',async()=>{
 const f=await fixture(false,'Make: Toyota\nVIN: WVWZZZ1JZXW000001');await f.drain();await addPhoto(f);await f.drain();
 f.calls.length=0;f.hooks.imageAccessBlocked=true;
 const first=await addPdf(f,'first history');
 const pending=await f.analyses.loadReport(f.publicId);expect(pending?.review).toMatchObject({text:'complete',images:{complete:1},final:'pending'});
 await f.drain();
 if(!f.calls.length)throw Error(JSON.stringify({jobs:(await client.from('analysis_jobs').select('stage,status,last_error').eq('analysis_id',f.id)).data,commitError:f.hooks.commitError}));
 expect(f.calls.map(input=>input.pass)).toEqual(['final']);
 expect(f.calls[0]?.sourceRecords).toContainEqual(expect.objectContaining({kind:'manual_excerpt',content:expect.stringContaining('first history')}));
 const second=await addPdf(f,'second history');f.calls.length=0;await f.drain();
 expect(f.calls.map(input=>input.pass)).toEqual(['final']);
 expect(f.calls[0]?.sourceRecords.filter(record=>record.kind==='manual_excerpt')).toHaveLength(2);
 const rows=await f.executions.loadExecutions(f.id,second.runId);expect(rows.map(row=>row.pass).sort()).toEqual(['final','image','text']);
 const origins=await client.from('review_executions').select('run_id,reused_from_execution_id').eq('analysis_id',f.id).eq('run_id',second.runId).neq('pass','final');
 expect(origins.error).toBeNull();expect(origins.data?.every(row=>row.reused_from_execution_id)).toBe(true);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');expect(first.runId).not.toBe(second.runId);
});
it.each(['image','final'] as const)('PDF during parent %s preserves remaining photo work and blocks stale final publication',async(phase)=>{
 const f=await fixture();await f.drain();let parent=await addPhoto(f);if(phase==='image')parent=await addPhoto(f);f.calls.length=0;let child='';
 f.hooks.onReview=async input=>{if(input.pass===phase&&!child){child=(await addPdf(f)).runId;const job=await f.jobs.leaseForAnalysis('blocked-child',60,f.id);expect(job).toBeNull();}};
 await f.drain();expect(child).not.toBe('');
 expect(f.calls.map(input=>input.pass)).toEqual(phase==='image'?['text','image','image','final']:['text','image','final','final']);
 const parentRows=await f.executions.loadExecutions(f.id,parent.runId);
 expect(parentRows.find(row=>row.pass==='text')?.resultHash).toBeTruthy();expect(parentRows.filter(row=>row.pass==='image')).toHaveLength(phase==='image'?2:1);expect(parentRows.filter(row=>row.pass==='image').every(row=>row.resultHash)).toBe(true);
 expect(parentRows.find(row=>row.pass==='final')?.resultHash).toBeFalsy();
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});
it('PDF accepted before parent snapshot pinning waits for and reuses parent review',async()=>{
 const f=await fixture();
 let parentJob;for(let index=0;index<10;index++){const job=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);if(!job)throw Error('Missing parent job');if(job.stage==='enrich'){parentJob=job;break;}await processJob(job,{workerId:'durable-fixture-worker',jobs:f.jobs,stages:f.stages});}
 expect(parentJob).toBeTruthy();expect(await f.executions.loadSnapshot(f.id,parentJob!.runId)).toBeNull();
 const child=await addPdf(f);expect(await f.jobs.leaseForAnalysis('blocked-prepin',60,f.id)).toBeNull();
 await processJob(parentJob!,{workerId:'durable-fixture-worker',jobs:f.jobs,stages:f.stages});await f.drain();
 expect(f.calls.map(input=>input.pass)).toEqual(['text','final']);
 expect((await f.executions.loadExecutions(f.id,child.runId)).find(row=>row.pass==='text')?.resultHash).toBeTruthy();
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});

it('PDF acceptance at the final commit boundary closes the stale attempt and unblocks child final',async()=>{
 const f=await fixture();await f.drain();const parent=await addPhoto(f);f.calls.length=0;
 const commit=f.executions.commitAttempt.bind(f.executions);let child='';
 f.executions.commitAttempt=async(lease,attemptId,outcome)=>{
  if(outcome.publication&&!child)child=(await addPdf(f)).runId;
  return commit(lease,attemptId,outcome);
 };
 await f.drain();expect(child).not.toBe('');
 expect(f.calls.map(input=>input.pass)).toEqual(['text','image','final','final']);
 const old=await f.executions.loadExecutions(f.id,parent.runId);expect(old.find(row=>row.pass==='final')?.resultHash).toBeNull();
 const attempts=await client.from('review_attempts').select('state,warning_code').eq('analysis_id',f.id).eq('run_id',parent.runId).eq('execution_id',old.find(row=>row.pass==='final')!.id);
 expect(attempts.error).toBeNull();expect(attempts.data).toEqual([{state:'lost',warning_code:'superseded'}]);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});
it('does not complete an expired parent lease when a PDF wins the final commit race',async()=>{
 const f=await fixture();await f.drain();const parent=await addPhoto(f);
 const commit=f.executions.commitAttempt.bind(f.executions);let child='';
 f.executions.commitAttempt=async(lease,attemptId,outcome)=>{
  if(outcome.publication&&!child){
   child=(await addPdf(f)).runId;
   expect((await client.from('analysis_jobs').update({lease_expires_at:new Date(0).toISOString()}).eq('id',lease.jobId)).error).toBeNull();
  }
  return commit(lease,attemptId,outcome);
 };
 // Process only this leased job so expiry reclamation cannot hide lost ownership.
 const job=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);expect(job?.stage).toBe('enrich');
 await processJob(job!,{workerId:'durable-fixture-worker',jobs:f.jobs,stages:f.stages});expect(child).not.toBe('');
 const old=await f.executions.loadExecutions(f.id,parent.runId);expect(old.find(row=>row.pass==='final')?.resultHash).toBeNull();
 const parentJob=await client.from('analysis_jobs').select('status').eq('id',job!.id).single();expect(parentJob.data?.status).toBe('leased');
 const attempts=await client.from('review_attempts').select('state').eq('execution_id',old.find(row=>row.pass==='final')!.id);expect(attempts.data).toEqual([{state:'started'}]);
});

it('pins sanitized official URL text through the pipeline without scheduling another consumer',async()=>{
 const f=await fixture();await f.drain();
 const {error:saveError}=await client.rpc('save_analysis_background_check',{p_record:{
  analysis_id:f.id,service_job_id:'generated-fixture',status:'fetched',
  fetched_at:'2026-10-24T12:00:00.000Z',storage_key:'generated-fixture.pdf',
  size_bytes:10,sha256:'a'.repeat(64),text_content:'Generated https://EXAMPLE.test?fixture=value',
 }});
 expect(saveError).toBeNull();
 const {data:first,error:firstError}=await client.rpc('reconcile_analysis_background_check',{p_analysis_id:f.id});
 expect(firstError).toBeNull();expect(first.decision).toBe('scheduled');
 f.calls.length=0;await f.drain();
 const pinned=await f.executions.loadSnapshot(f.id,first.run_id);
 const official=pinned?.finalInput?.sourceRecords.find(source=>source.kind==='official_record');
 expect(typeof official?.content === 'string' && official.content.includes('https://example.test/')).toBe(true);
 expect(typeof official?.content === 'string' && official.content.includes('?fixture=')).toBe(false);
 for(let retry=0;retry<3;retry++){
  const {data:answer,error}=await client.rpc('reconcile_analysis_background_check',{p_analysis_id:f.id});
  expect(error).toBeNull();expect(answer.decision).toBe('included');expect(answer.run_id).toBe(first.run_id);
 }
 const {count}=await client.from('analysis_runs').select('id',{count:'exact',head:true}).eq('analysis_id',f.id);
 expect(count).toBe(2);
 expect((await f.analyses.loadReport(f.publicId))?.status).toBe('complete');
});


it.each([false,true])('publishes pinned VIN citations through the real database with review disabled=%s',async disabled=>{
 const f=await fixture(disabled,'Make: Toyota\nModel: Avensis\nYear: 2017\nVIN: WVWZZZ1JZXW000001');
 await f.drain();
 const saved=await client.rpc('save_analysis_background_check',{p_record:{analysis_id:f.id,service_job_id:'generated-fixture',status:'fetched',fetched_at:'2026-10-24T12:00:00.000Z',storage_key:'generated-fixture.pdf',size_bytes:10,sha256:'b'.repeat(64),text_content:'VIN: WVWZZZ1JZXW000002'}});
 expect(saved.error === null).toBe(true);
 const reconciled=await client.rpc('reconcile_analysis_background_check',{p_analysis_id:f.id});
 expect(reconciled.error === null).toBe(true);
 await f.drain();
 const report=await f.analyses.loadReport(f.publicId);
 const finding=report?.findings.find(item=>item.category==='background_check_vin_mismatch');
 expect(Boolean(finding)).toBe(true);
 expect(finding!.evidenceIds.every(id=>report!.evidence.some(item=>item.id===id))).toBe(true);
 expect(report!.actions.some(item=>item.findingId===finding!.id)).toBe(true);
});

it.each(['important','context'] as const)('publishes reused parent VIN observations with %s severity through commit_review_attempt',async severity=>{
 const f=await fixture(false,'Make: Toyota\nModel: Avensis\nYear: 2017\nVIN: WVWZZZ1JZXW000001');
 let parentVinId='';
 f.hooks.reviewResult=input=>{
  const observations=[];
  if(input.pass==='text'){
   parentVinId=input.evidence.find(item=>item.claim.startsWith('Listing VIN:'))!.id;
   observations.push({id:'parent-identity',evidenceIds:[parentVinId],category:'identity_context',title:'Verify supplied identity',severity,explanation:'Confirm the supplied identity in person.',recommendedAction:{kind:'inspection_task' as const,title:'Check identity',instructions:'Compare the supplied identity with the vehicle.'},confidence:0.8});
  }
  return {schemaVersion:1,observations,warnings:[]};
 };
 await f.drain();
 const saved=await client.rpc('save_analysis_background_check',{p_record:{analysis_id:f.id,service_job_id:'generated-fixture',status:'fetched',fetched_at:'2026-10-24T12:00:00.000Z',storage_key:'generated-fixture.pdf',size_bytes:10,sha256:'b'.repeat(64),text_content:'VIN: WVWZZZ1JZXW000002'}});
 expect(saved.error===null).toBe(true);
 const reconciled=await client.rpc('reconcile_analysis_background_check',{p_analysis_id:f.id});
 expect(reconciled.error===null).toBe(true);
 expect(reconciled.data.decision).toBe('scheduled');
 f.calls.length=0;
 await f.drain();
 expect(f.hooks.commitError===undefined).toBe(true);
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');
 const inherited=report?.findings.find(item=>item.title==='Verify supplied identity');
 expect(inherited?.evidenceIds).toEqual([parentVinId]);
 expect(f.calls.map(input=>input.pass)).toEqual(['final']);
 const finalInput=f.calls[0]!;
 expect(new Set(finalInput.evidence.map(item=>item.id)).size).toBe(finalInput.evidence.length);
 expect(new Set(finalInput.sourceRecords.map(item=>item.evidenceId)).size).toBe(finalInput.sourceRecords.length);
 const rows=await f.executions.loadExecutions(f.id,reconciled.data.run_id);
 expect(rows.some(row=>row.pass==='final'&&Boolean(row.resultHash))).toBe(true);
 const mismatch=report?.findings.find(item=>item.category==='background_check_vin_mismatch');
 expect(mismatch?.evidenceIds).toHaveLength(2);
 expect(mismatch?.evidenceIds.includes(parentVinId)).toBe(true);
 expect(mismatch?.evidenceIds.some(id=>report?.evidence.some(item=>item.id===id&&item.sourceClass==='official_registry'))).toBe(true);
});


it('parses the fetched PDF report and exposes one canonical official source',async()=>{
 const f=await fixture();await f.drain();
 await saveBackgroundCheck({analysis_id:f.id,service_job_id:'generated-schema-fixture',status:'fetched',reason:null,requested_at:new Date().toISOString(),searched_by:'vin',fetched_at:new Date().toISOString(),storage_key:'generated-fixture.pdf',size_bytes:10,sha256:'c'.repeat(64),text_content:'Generated official record.'},client);
 await reconcileBackgroundCheck(f.id,client);await f.drain();
 const report=await f.analyses.loadReport(f.publicId);
 expect(AnalysisReportSchema.safeParse(report).success).toBe(true);
 expect(Object.values(report!.sources).filter(source=>source.label?.includes('Transport Administration')).length).toBe(1);
 expect(report!.sources.transportAdministration?.url).toBe(`/api/analyses/${f.publicId}/background-check/pdf`);
});

it('leases the PDF child after its deferred parent becomes available and preserves official final input',async()=>{
 const f=await fixture(false,'Make: Toyota\nModel: Avensis\nYear: 2017\nVIN: WVWZZZ1JZXW000001');
 await saveBackgroundCheck({analysis_id:f.id,service_job_id:'generated-deferred-fixture',status:'pending',reason:null,requested_at:new Date().toISOString(),searched_by:'vin',fetched_at:null,storage_key:null,size_bytes:null,sha256:null},client);
 // Use the real defer RPC without loading production environment configuration.
 const drain=async()=>{for(let i=0;i<12;i++){
  const job=await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id);if(!job)return;
  await processJob(job,{workerId:'durable-fixture-worker',jobs:f.jobs,stages:f.stages,defer:async(job,until)=>{
   const result=await client.rpc('defer_analysis_job',{p_job_id:job.id,p_worker_id:'durable-fixture-worker',p_available_at:until.toISOString()});expect(result.error===null).toBe(true);
  }});
 }throw Error('Pipeline did not settle');};
 await drain();
 const pending=await getBackgroundCheckWithText(f.id,client);
 await saveBackgroundCheck({...pending!,status:'fetched',reason:null,fetched_at:new Date().toISOString(),storage_key:'generated-fixture.pdf',size_bytes:10,sha256:'d'.repeat(64),text_content:'VIN: WVWZZZ1JZXW000002'},client);
 const child=await reconcileBackgroundCheck(f.id,client);
 const queued=await client.from('analysis_jobs').select('stage,status').eq('analysis_id',f.id).eq('run_id',child.run_id);
 expect(queued.data?.some(job=>job.stage==='enrich'&&job.status==='queued')).toBe(true);
 expect(await f.jobs.leaseForAnalysis('durable-fixture-worker',60,f.id)).toBeNull();
 // The child is intentionally blocked by its queued parent, whose five second defer has not expired.
 expect((await client.from('analysis_jobs').update({available_at:new Date(0).toISOString()}).eq('analysis_id',f.id).eq('stage','enrich').eq('status','queued')).error===null).toBe(true);
 const publicRecord=await getBackgroundCheck(f.id,client);
 const workerRecord=await getBackgroundCheckWithText(f.id,client);
 expect(publicRecord?.text_content===undefined&&publicRecord?.owner_run_id===undefined).toBe(true);
 expect(Boolean(workerRecord?.text_content&&workerRecord?.owner_run_id&&workerRecord?.evidence_id)).toBe(true);
 f.hooks.reviewResult=input=>({schemaVersion:1,warnings:[],observations:input.pass==='final'&&input.sourceRecords.some(source=>source.kind==='official_record')?[{id:'official-context',evidenceIds:[input.sourceRecords.find(source=>source.kind==='official_record')!.evidenceId],category:'official_history',title:'Official background check included',severity:'context',explanation:'Generated official evidence.',recommendedAction:{kind:'inspection_task',title:'Check record',instructions:'Compare the generated record.'},confidence:0.8}]:[]});
 await drain();
 const report=await f.analyses.loadReport(f.publicId);
 expect(report?.status).toBe('complete');
 expect(report?.findings.some(finding=>finding.category==='background_check_vin_mismatch')).toBe(true);
 expect(report?.findings.some(finding=>finding.title==='Official background check included')).toBe(true);
 const final=f.calls.findLast(input=>input.pass==='final');
 expect(final?.sourceRecords.some(source=>source.kind==='official_record'&&source.providedBy==='transpordiamet')).toBe(true);
});
