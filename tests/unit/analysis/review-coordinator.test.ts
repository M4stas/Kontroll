import { expect,it,vi } from 'vitest';
import {coordinateReviews} from '@/analysis/review-coordinator';
import type {ReviewProgress} from '@/domain/analysis';
import type {ReviewInput,ReviewResult} from '@/insights/types';
import type {ReviewExecutionRecord,ReviewLease,ReviewRunSnapshot} from '@/server/repositories/review-executions';
import {normalizeVehicle} from '@/analysis/normalize';
import {createFallbackSnapshot} from '@/listings/fallback';
const vehicle=normalizeVehicle(createFallbackSnapshot({originalListingUrl:new URL('https://example.test/car'),pastedDescription:'',screenshotRefs:[]}));
const empty={schemaVersion:1 as const,observations:[],warnings:[]};
const lease={analysisId:'a',runId:'r',jobId:'j',workerId:'w'};
const snapshot={id:'snapshot',analysisId:'a',runId:'r',inputHash:'hash',locale:'en',mode:'unified',input:{vehicle,listing:null,sourceRecords:[],evidence:[]},imageManifest:{counts:{supplied:1,selected:1,accepted:1,unavailable:0,rejected:0,skipped:0},images:[{evidenceId:'image',selected:true,status:'accepted',storageKey:'a/image',contentHash:'hash'}]},passes:{text:{availability:'ready'},image:{availability:'ready'},final:{availability:'ready'}}} as unknown as ReviewRunSnapshot;
function harness(failImage=false){
 const records:ReviewExecutionRecord[]=[];const order:string[]=[];let sequence=0;
 const repository={loadExecutions:async()=>records,ensureExecution:async(_lease:ReviewLease,_id:string,descriptor:{input:ReviewInput})=>{const existing=records.find(r=>r.pass===descriptor.input.pass&&r.imageEvidenceId===(descriptor.input.imageEvidenceId??null));if(existing)return existing;const execution={id:String(++sequence),analysisId:lease.analysisId,runId:lease.runId,snapshotId:_id,pass:descriptor.input.pass,imageEvidenceId:descriptor.input.imageEvidenceId??null,result:null} as ReviewExecutionRecord;records.push(execution);return execution;},startAttempt:async(_lease:ReviewLease,id:string)=>({id,attemptNumber:1}),commitAttempt:async(_lease:ReviewLease,id:string,data:{outcome:string;result?:unknown})=>{order.push(`commit:${records.find(r=>r.id===id)!.pass}`);if(data.outcome==='success'){const row=records.find(r=>r.id===id);row!.result=data.result as ReviewResult;row!.resultHash='database-owned-result-hash';}}};
 const review=async(input:ReviewInput)=>{order.push(`call:${input.pass}`);return input.pass==='image'&&failImage?{...empty,warnings:[{code:'timeout' as const,message:'Timed out'}]}:empty;};
 return {repository,order,records,review};
}
it('starts final review only after text and every selected image result commit',async()=>{
 const run=coordinateReviews;expect(run).toBeTypeOf('function');if(!run)return;
 const h=harness();const publication=vi.fn().mockReturnValue({});
 await run({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({version:1,payload:'payload',signature:'signature'}),publication});
 expect(h.order).toEqual(['call:text','commit:text','call:image','commit:image','call:final','commit:final']);
 expect(publication).toHaveBeenCalledTimes(1);
 h.order.length=0;
 await run({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication});
 expect(h.order).toEqual([]);expect(publication).toHaveBeenCalledTimes(1);
});
it('preserves committed text on image retry without starting final early',async()=>{
 const run=coordinateReviews;expect(run).toBeTypeOf('function');if(!run)return;
 const h=harness(true);const publication=vi.fn();
 await expect(run({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication})).rejects.toMatchObject({transient:true});
 expect(h.records[0]!.result).toEqual(empty);expect(h.order).not.toContain('call:final');expect(publication).not.toHaveBeenCalled();
});
it('does not rewrite progress after a final result is already committed',async()=>{
 const run=coordinateReviews;const h=harness();const progress=vi.fn();
 h.records.push({id:'final',pass:'final',result:empty,resultHash:'hash'} as unknown as ReviewExecutionRecord);
 const result=await run({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication:()=>({} as never),progress});
 expect(result.state).toBe('complete');expect(progress).not.toHaveBeenCalled();expect(h.order).toEqual([]);
});
it('validates adapter citations at the common commit boundary',async()=>{
 const run=coordinateReviews;const h=harness();
 const malicious={...empty,observations:[{id:'bad',evidenceIds:['foreign'],category:'condition',title:'Defect',severity:'important' as const,explanation:'Claim',recommendedAction:{kind:'inspection_task' as const,title:'Inspect',instructions:'Inspect'},confidence:0.9}]};
 await expect(run({lease,snapshot,repository:h.repository,reviewer:()=>({review:async()=>malicious}),imageCapability:async()=>({}),publication:()=>({} as never)})).rejects.toMatchObject({transient:true});
 expect(h.records[0]!.result).toBeNull();expect(h.order).not.toContain('call:final');
});
it('retries only final assessment after prior text/image results committed',async()=>{
 const h=harness();let failFinal=true;let publications=0;
 const deps={lease,snapshot,repository:h.repository,imageCapability:async()=>({}),publication:()=>{publications++;return {} as never;},reviewer:()=>({review:async(input:ReviewInput)=>{if(input.pass==='final'&&failFinal){h.order.push('call:final');return {...empty,warnings:[{code:'timeout' as const,message:'Timed out'}]};}return h.review(input);}})};
 await expect(coordinateReviews(deps)).rejects.toMatchObject({transient:true});
 expect(publications).toBe(0);h.order.length=0;failFinal=false;
 await coordinateReviews(deps);
 expect(h.order).toEqual(['call:final','commit:final']);expect(publications).toBe(1);
});
it('does not start final when a supplied selected image is unavailable',async()=>{
 const h=harness();const unavailableSnapshot={...snapshot,imageManifest:{...snapshot.imageManifest,images:[{...snapshot.imageManifest.images[0]!,status:'unavailable' as const}]}};
 await expect(coordinateReviews({lease,snapshot:unavailableSnapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication:()=>({} as never)})).rejects.toMatchObject({transient:true});
 expect(h.order).toEqual(['call:text','commit:text']);
});
it('continues ready image work after text review failure and blocks final',async()=>{
 const h=harness();
 await expect(coordinateReviews({lease,snapshot,repository:h.repository,imageCapability:async()=>({}),publication:()=>({} as never),reviewer:()=>({review:async(input:ReviewInput)=>{if(input.pass==='text')return {...empty,warnings:[{code:'timeout' as const,message:'Timeout'}]};return h.review(input);}})})).rejects.toMatchObject({transient:true});
 expect(h.records.find(record=>record.pass==='image')?.result).toEqual(empty);expect(h.order).not.toContain('call:final');
});
it('commits later selected images after an earlier image review times out',async()=>{
 const h=harness();const twoImages={...snapshot,imageManifest:{counts:{supplied:2,selected:2,accepted:2,unavailable:0,rejected:0,skipped:0},images:[snapshot.imageManifest.images[0]!,{...snapshot.imageManifest.images[0]!,evidenceId:'second-image',storageKey:'a/second'}]}};
 await expect(coordinateReviews({lease,snapshot:twoImages,repository:h.repository,imageCapability:async()=>({}),publication:()=>({} as never),reviewer:()=>({review:async(input:ReviewInput)=>input.imageEvidenceId==='image'?{...empty,warnings:[{code:'timeout' as const,message:'Timeout'}]}:h.review(input)})})).rejects.toMatchObject({transient:true});
 expect(h.records.find(record=>record.imageEvidenceId==='second-image')?.result).toEqual(empty);expect(h.records.find(record=>record.imageEvidenceId==='image')?.result).toBeNull();expect(h.order).not.toContain('call:final');
});

it('reuses committed image results after final failure without reading image storage again', async () => {
 const h = harness();
 let failFinal = true;
 const imageCapability = vi.fn().mockResolvedValue({});
 const deps = {lease, snapshot, repository: h.repository, imageCapability,
  publication: () => ({} as never), reviewer: () => ({review: async (input: ReviewInput) => {
   if (input.pass === 'final' && failFinal) return {...empty, warnings: [{code: 'timeout' as const, message: 'Timeout'}]};
   return h.review(input);
  }})};
 await expect(coordinateReviews(deps)).rejects.toMatchObject({transient: true});
 expect(imageCapability).toHaveBeenCalledTimes(1);
 h.order.length = 0;
 failFinal = false;
 imageCapability.mockRejectedValue(new Error('Storage is unavailable'));
 await coordinateReviews(deps);
 expect(imageCapability).toHaveBeenCalledTimes(1);
 expect(h.order).toEqual(['call:final', 'commit:final']);
});
it.each(['snapshot', 'image', 'missing_hash'])('does not reuse an image result with invalid %s identity', async (invalid) => {
 const h = harness();
 const cached = {id: 'cached', analysisId: lease.analysisId, runId: lease.runId,
  snapshotId: snapshot.id, pass: 'image', imageEvidenceId: 'image', result: empty,
  resultHash: 'database-owned-result-hash'} as unknown as ReviewExecutionRecord;
 if (invalid === 'snapshot') cached.snapshotId = 'foreign-snapshot';
 if (invalid === 'image') cached.imageEvidenceId = 'foreign-image';
 if (invalid === 'missing_hash') cached.resultHash = null;
 h.records.push(cached);
 const imageCapability = vi.fn().mockRejectedValue(new Error('Storage is unavailable'));
 await expect(coordinateReviews({lease, snapshot, repository: h.repository, imageCapability,
  reviewer: () => ({review: h.review}), publication: () => ({} as never)})).rejects.toMatchObject({transient: true});
 expect(imageCapability).toHaveBeenCalledTimes(1);
 expect(h.order).not.toContain('call:final');
});

it('emits immutable per-image progress before review and after durable commit', async () => {
 const h=harness();const updates:ReviewProgress[]=[];
 const original=h.repository.commitAttempt;
 h.repository.commitAttempt=async (...args)=>{if(args[2].outcome==='success'&&h.records.find(r=>r.id===args[1])?.pass==='image')expect(updates.at(-1)!.images.items![0]!.state).toBe('running');await original(...args);};
 const result=await coordinateReviews({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication:()=>({} as never),progress:async p=>{updates.push(p);}});
 expect(updates.some(p=>p.images.items?.[0]?.state==='running')).toBe(true);
 expect(result.images.items).toEqual([{evidenceId:'image',state:'complete'}]);
 expect(updates[0]!.images.items![0]!.state).toBe('pending');
});
it('includes unavailable and skipped manifest images in cached final progress',async()=>{
 const h=harness();h.records.push({id:'final',pass:'final',result:empty,resultHash:'hash'} as unknown as ReviewExecutionRecord);
 const expanded={...snapshot,imageManifest:{...snapshot.imageManifest,images:[...snapshot.imageManifest.images,{evidenceId:'missing',selected:false,status:'unavailable' as const},{evidenceId:'skipped',selected:false,status:'skipped' as const}]}};
 const result=await coordinateReviews({lease,snapshot:expanded,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication:()=>({} as never)});
 expect(result.images.items).toEqual([{evidenceId:'image',state:'complete'},{evidenceId:'missing',state:'unavailable'},{evidenceId:'skipped',state:'skipped'}]);
});

it('restores committed image counts and text state before retrying final',async()=>{
 const h=harness();let failFinal=true;const updates:ReviewProgress[]=[];
 const deps={lease,snapshot,repository:h.repository,imageCapability:async()=>({}),publication:()=>({} as never),progress:async(p:ReviewProgress)=>{updates.push(p);},reviewer:()=>({review:async(input:ReviewInput)=>input.pass==='final'&&failFinal?{...empty,warnings:[{code:'timeout' as const,message:'Timeout'}]}:h.review(input)})};
 await expect(coordinateReviews(deps)).rejects.toMatchObject({transient:true});updates.length=0;failFinal=false;
 await coordinateReviews(deps);
 expect(updates[0]!.images.complete).toBe(1);expect(updates[0]!.text).toBe('complete');expect(updates[0]!.images.items![0]!.state).toBe('complete');
});
it('does not emit image complete when its durable commit fails',async()=>{
 const h=harness();const updates:ReviewProgress[]=[];
 const original=h.repository.commitAttempt;
 h.repository.commitAttempt=async(...args)=>{if(h.records.find(r=>r.id===args[1])?.pass==='image')throw new Error('database failed');await original(...args);};
 await expect(coordinateReviews({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication:()=>({} as never),progress:async p=>{updates.push(p);}})).rejects.toThrow('database failed');
 expect(updates.every(p=>p.images.items![0]!.state!=='complete')).toBe(true);
});
