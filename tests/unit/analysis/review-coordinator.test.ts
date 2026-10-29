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
 expect([...h.order.slice(0,4)].sort()).toEqual(['call:image','call:text','commit:image','commit:text']);
 expect(h.order.slice(4)).toEqual(['call:final','commit:final']);
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

it('finishes all image work but skips stale final when a PDF child supersedes the run', async () => {
 const h=harness();const publication=vi.fn();
 const result=await coordinateReviews({lease,snapshot,repository:h.repository,reviewer:()=>({review:h.review}),imageCapability:async()=>({}),publication,shouldFinalize:async()=>false});
 expect([...h.order].sort()).toEqual(['call:image','call:text','commit:image','commit:text']);
 expect(result.images.complete).toBe(1);expect(result.final).toBe('pending');expect(publication).not.toHaveBeenCalled();
});

it('sends supplemental PDF material only to final review', async () => {
 const h=harness();const inputs:ReviewInput[]=[];
 const finalInput={...snapshot.input,sourceRecords:[{evidenceId:'pdf',sourceId:'pdf-source',kind:'manual_excerpt' as const,content:'Untrusted user document. Page 1: mileage 12345'}],evidence:[{id:'pdf',sourceId:'pdf-source',sourceClass:'buyer' as const,claim:'PDF',applicability:'unverified',confidence:0.5,verification:'unverified' as const,capturedAt:'2026-01-01T00:00:00Z'}]};
 await coordinateReviews({lease,snapshot:{...snapshot,finalInput},repository:h.repository,reviewer:()=>({review:async input=>{inputs.push(input);return empty;}}),imageCapability:async()=>({}),publication:()=>({} as never)});
 const byPass=(pass:ReviewInput['pass'])=>inputs.find(input=>input.pass===pass)!;
 expect(byPass('text').sourceRecords).toEqual([]);expect(byPass('image').sourceRecords).toEqual([]);expect(byPass('final').sourceRecords).toEqual(finalInput.sourceRecords);
});


function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return {promise, resolve};
}
function imageSnapshot(count: number): ReviewRunSnapshot {
 return {...snapshot, imageManifest: {
  counts: {supplied: count, selected: count, accepted: count, unavailable: 0, rejected: 0, skipped: 0},
  images: Array.from({length: count}, (_, index) => ({...snapshot.imageManifest.images[0]!, evidenceId: `image-${index}`, storageKey: `a/image-${index}`})),
 }};
}

it('runs at most eight images concurrently and supplies final reviews in manifest order after durable commits', async () => {
 const h = harness();
 const gates = Array.from({length: 10}, () => deferred<ReviewResult>());
 const started: string[] = [];
 const inputs: ReviewInput[] = [];
 const ids = (count: number) => Array.from({length: count}, (_, index) => `image-${index}`);
 let active = 0;
 let peak = 0;
 const running = coordinateReviews({lease, snapshot: imageSnapshot(10), repository: h.repository,
  imageCapability: async () => ({}), publication: () => ({} as never),
  reviewer: () => ({review: async input => {
   inputs.push(input);
   if (input.pass !== 'image') {
    if (input.pass === 'final') expect(h.records.filter(record => record.pass === 'image' && record.resultHash)).toHaveLength(10);
    return h.review(input);
   }
   started.push(input.imageEvidenceId!);
   peak = Math.max(peak, ++active);
   const result = await gates[Number(input.imageEvidenceId!.split('-')[1])]!.promise;
   active--;
   return result;
  }}),
 });
 try {
  await vi.waitFor(() => expect(started).toEqual(ids(8)));
  gates[7]!.resolve(empty);
  await vi.waitFor(() => expect(started).toEqual(ids(9)));
  gates[8]!.resolve(empty);
  await vi.waitFor(() => expect(started).toHaveLength(10));
  expect(inputs.some(input => input.pass === 'final')).toBe(false);
  [9, 6, 5, 4, 3, 2, 1, 0].forEach(index => gates[index]!.resolve(empty));
  const result = await running;
  expect(peak).toBe(8);
  expect(inputs.at(-1)!.priorReviews?.map(review => review.imageEvidenceId ?? review.pass)).toEqual(['text', ...ids(10)]);
  expect(result.images.complete).toBe(10);
 } finally {
  gates.forEach(gate => gate.resolve(empty));
  await running;
 }
});

it('serializes immutable progress snapshots while slow writes block subsequent image progress', async () => {
 const h = harness();
 const gates = Array.from({length: 3}, () => deferred<ReviewResult>());
 const slowWrite = deferred<void>();
 const started: string[] = [];
 const persisted: ReviewProgress[] = [];
 let activeWrites = 0;
 let peakWrites = 0;
 let blockedSnapshot: ReviewProgress | undefined;
 const running = coordinateReviews({lease, snapshot: imageSnapshot(3), repository: h.repository,
  imageCapability: async () => ({}), publication: () => ({} as never),
  reviewer: () => ({review: async input => {
   if (input.pass !== 'image') return empty;
   started.push(input.imageEvidenceId!);
   return gates[Number(input.imageEvidenceId!.split('-')[1])]!.promise;
  }}),
  progress: async update => {
   peakWrites = Math.max(peakWrites, ++activeWrites);
   if (update.images.complete === 1) { blockedSnapshot = update; await slowWrite.promise; }
   persisted.push(update);
   activeWrites--;
  },
 });
 try {
  await vi.waitFor(() => expect(started).toHaveLength(3));
  gates[0]!.resolve(empty);
  await vi.waitFor(() => expect(blockedSnapshot?.images.complete).toBe(1));
  gates[1]!.resolve(empty);
  gates[2]!.resolve(empty);
  await vi.waitFor(() => expect(h.records.filter(record => record.pass === 'image' && record.resultHash)).toHaveLength(3));
  expect(peakWrites).toBe(1);
  expect(blockedSnapshot!.images.complete).toBe(1);
  expect(h.records.some(record => record.pass === 'final')).toBe(false);
  slowWrite.resolve();
  await running;
  expect(persisted.map(update => update.images.complete)).toEqual([...persisted.map(update => update.images.complete)].sort((a, b) => a - b));
  expect(persisted.at(-1)!.images.complete).toBe(3);
 } finally {
  gates.forEach(gate => gate.resolve(empty)); slowWrite.resolve(); await running;
 }
});

it('drains started siblings after an infrastructure failure without scheduling remaining images or final', async () => {
 const h = harness();
 const gates = Array.from({length: 10}, () => deferred<ReviewResult>());
 const started: string[] = [];
 const databaseFailed = deferred<void>();
 const originalCommit = h.repository.commitAttempt;
 h.repository.commitAttempt = async (...args) => {
  if (h.records.find(record => record.id === args[1])?.imageEvidenceId === 'image-0') {
   databaseFailed.resolve(); throw new Error('database failed');
  }
  await originalCommit(...args);
 };
 let settled = false;
 const running = coordinateReviews({lease, snapshot: imageSnapshot(10), repository: h.repository,
  imageCapability: async () => ({}), publication: () => ({} as never),
  reviewer: () => ({review: async input => {
   if (input.pass !== 'image') return h.review(input);
   started.push(input.imageEvidenceId!);
   return gates[Number(input.imageEvidenceId!.split('-')[1])]!.promise;
  }}),
 });
 const outcome = running.then(() => undefined, error => error).finally(() => { settled = true; });
 try {
  await vi.waitFor(() => expect(started).toHaveLength(8));
  gates[0]!.resolve(empty);
  await databaseFailed.promise;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(started).toEqual(Array.from({length: 8}, (_, index) => `image-${index}`));
  [7, 6, 5, 4, 3, 2, 1].forEach(index => gates[index]!.resolve(empty));
  expect(await outcome).toMatchObject({message: 'database failed'});
  expect(h.records.filter(record => record.pass === 'image' && record.resultHash).map(record => record.imageEvidenceId).sort()).toEqual(['image-1', 'image-2', 'image-3', 'image-4', 'image-5', 'image-6', 'image-7']);
  expect(h.records.some(record => record.pass === 'final')).toBe(false);
  expect(started).toHaveLength(8);
 } finally { gates.forEach(gate => gate.resolve(empty)); await outcome; }
});

it('continues after provider warnings and retries only failed images without capabilities for cached siblings', async () => {
 const h = harness();
 let retry = false;
 const accessed: string[] = [];
 const reviewed: string[] = [];
 const deps = {lease, snapshot: imageSnapshot(5), repository: h.repository,
  imageCapability: async (id: string) => {
   accessed.push(id);
   if (retry && id !== 'image-1') throw new Error('Cached storage is unavailable');
   return {};
  }, publication: () => ({} as never), reviewer: () => ({review: async (input: ReviewInput) => {
   reviewed.push(input.imageEvidenceId ?? input.pass);
   return !retry && input.imageEvidenceId === 'image-1' ? {...empty, warnings: [{code: 'timeout' as const, message: 'Timeout'}]} : empty;
  }}),
 };
 await expect(coordinateReviews(deps)).rejects.toMatchObject({transient: true});
 expect(h.records.filter(record => record.pass === 'image' && record.resultHash)).toHaveLength(4);
 expect(reviewed).not.toContain('final');
 retry = true; accessed.length = 0; reviewed.length = 0;
 const result = await coordinateReviews(deps);
 expect(accessed).toEqual(['image-1']);
 expect(reviewed).toEqual(['image-1', 'final']);
 expect(result.images.complete).toBe(5);
});

it('runs the text review while photo reviews are in flight', async () => {
 const h=harness();let releaseText!:()=>void;const textGate=new Promise<void>(resolve=>{releaseText=resolve;});const fallback=setTimeout(()=>releaseText(),50);
 const review=async(input:ReviewInput)=>{if(input.pass==='text'){h.order.push('call:text');await textGate;return empty;}if(input.pass==='image')releaseText();return h.review(input);};
 await coordinateReviews({lease,snapshot,repository:h.repository,reviewer:()=>({review}),imageCapability:async()=>({}),publication:()=>({} as never)});
 clearTimeout(fallback);
 expect(h.order.indexOf('call:image')).toBeLessThan(h.order.indexOf('commit:text'));
 expect(h.order.slice(-2)).toEqual(['call:final','commit:final']);
});

it('drains started photos and rethrows when the text commit fails', async () => {
 const h = harness();
 const gates = Array.from({length: 10}, () => deferred<ReviewResult>());
 const started: string[] = [];
 const originalCommit = h.repository.commitAttempt;
 let textFailed = false;
 h.repository.commitAttempt = async (...args) => {
  if (h.records.find(record => record.id === args[1])?.pass === 'text') { textFailed = true; throw new Error('text commit failed'); }
  await originalCommit(...args);
 };
 let settled = false;
 const running = coordinateReviews({lease, snapshot: imageSnapshot(10), repository: h.repository,
  imageCapability: async () => ({}), publication: () => ({} as never),
  reviewer: () => ({review: async input => {
   if (input.pass !== 'image') return h.review(input);
   started.push(input.imageEvidenceId!);
   return gates[Number(input.imageEvidenceId!.split('-')[1])]!.promise;
  }}),
 });
 const outcome = running.then(() => undefined, error => error).finally(() => { settled = true; });
 try {
  await vi.waitFor(() => expect(started).toHaveLength(8));
  await vi.waitFor(() => expect(textFailed).toBe(true));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  [0, 1, 2, 3, 4, 5, 6, 7].forEach(index => gates[index]!.resolve(empty));
  expect(await outcome).toMatchObject({message: 'text commit failed'});
  expect(h.records.filter(record => record.pass === 'image' && record.resultHash)).toHaveLength(8);
  expect(started).toHaveLength(8);
  expect(h.records.some(record => record.pass === 'final')).toBe(false);
 } finally { gates.forEach(gate => gate.resolve(empty)); await outcome; }
});
