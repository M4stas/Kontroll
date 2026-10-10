// @vitest-environment node
import { expect, it } from 'vitest';
import { PhotoTimingRecorder, runPhotoTimingJob, withPhotoTiming, measurePhotoPhase } from '@/diagnostics/photo-timings';

it('preserves values/errors and records monotonic durations without awaiting a collector', async () => {
  let tick = 10;
  const rows: Array<Record<string, unknown>> = [];
  const recorder = new PhotoTimingRecorder({ enabled: true, monotonic: () => tick, write: async batch => { rows.push(...batch); } });
  const original = Error('private original');
  const value = { bytes: new Uint8Array([1, 2]) };
  await runPhotoTimingJob(recorder, async () => withPhotoTiming('photo', async () => {
    expect(await measurePhotoPhase('download', async () => { tick = 35; return value; })).toBe(value);
    await expect(measurePhotoPhase('validation', async () => { tick = 40; throw original; })).rejects.toBe(original);
  }));
  expect(rows.filter(row => row.state === 'complete')).toEqual([expect.objectContaining({ phase: 'download', durationMs: 25 })]);
  expect(rows.find(row => row.state === 'failed')).toMatchObject({ phase: 'validation', durationMs: 5, errorCode: 'phase_failed' });
  expect(JSON.stringify(rows)).not.toContain('private original');
});
it('binds overlapping photos and parents independently', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const recorder = new PhotoTimingRecorder({ enabled: true, write: async batch => { rows.push(...batch); } });
  await runPhotoTimingJob(recorder, async () => Promise.all(['a','b','c'].map(id => withPhotoTiming(id, () => measurePhotoPhase('capture_prepare', () => measurePhotoPhase('download', async () => id))))));
  for (const id of ['a','b','c']) {
    const parent = rows.find(row => row.evidenceId === id && row.phase === 'capture_prepare');
    expect(rows.find(row => row.evidenceId === id && row.phase === 'download')?.parentId).toBe(parent?.id);
  }
});
it('disables collection and bounds collector outage flush to 100 ms', async () => {
  let writes = 0;
  const disabled = new PhotoTimingRecorder({ enabled: false, write: async () => { writes++; } });
  await runPhotoTimingJob(disabled, () => withPhotoTiming('a', () => measurePhotoPhase('download', async () => 7)));
  expect(writes).toBe(0);
  let aborted = false;
  const broken = new PhotoTimingRecorder({ enabled: true, write: async (_rows, signal) => { signal.addEventListener('abort', () => { aborted = true; }); await new Promise(() => {}); } });
  const start = performance.now();
  expect(await runPhotoTimingJob(broken, () => withPhotoTiming('a', () => measurePhotoPhase('download', async () => 7)))).toBe(7);
  expect(performance.now() - start).toBeLessThan(160);
  expect(aborted).toBe(true);
});
it('measures actual listing download and validation, including rejected image bytes', async () => {
  const { prepareListingPhotos } = await import('@/listings/photos');
  const rows: Array<Record<string, unknown>> = [];
  let tick=0;
  const recorder=new PhotoTimingRecorder({enabled:true,monotonic:()=>tick,write:async batch=>{rows.push(...batch);}});
  const result=await runPhotoTimingJob(recorder,()=>prepareListingPhotos('analysis',['https://img.auto24.ee/a.jpg'],{download:async()=>{tick=20;return new Uint8Array([1,2,3]);},upload:async()=>{throw Error('must not upload');}}));
  expect(result.counts.rejected).toBe(1);
  expect(rows.find(row=>row.phase==='download'&&row.state==='complete')).toMatchObject({durationMs:20});
  expect(rows.find(row=>row.phase==='validation'&&row.state==='failed')).toBeDefined();
  expect(rows.find(row=>row.phase==='upload')).toBeUndefined();
});
it('persists an incomplete marker after a recoverable collector outage', async () => {
  let failed=false;
  const rows:Array<Record<string,unknown>>=[];
  const recorder=new PhotoTimingRecorder({enabled:true,write:async batch=>{if(!failed){failed=true;throw Error('outage');} rows.push(...batch);}});
  await runPhotoTimingJob(recorder,()=>withPhotoTiming('photo',()=>measurePhotoPhase('download',async()=>1)));
  expect(rows.some(row=>Number(row.omittedCount)>0)).toBe(true);
});
it('keeps monotonic durations valid when wall time moves backwards',async()=>{
 const rows:Array<Record<string,unknown>>=[];
 let time=new Date('2026-10-10T12:00:00Z');
 const recorder=new PhotoTimingRecorder({enabled:true,now:()=>time,write:async batch=>{rows.push(...batch);}});
 await runPhotoTimingJob(recorder,()=>withPhotoTiming('photo',()=>measurePhotoPhase('download',async()=>{time=new Date('2026-10-09T12:00:00Z');})));
 const finished=rows.find(row=>row.state==='complete')!;
 expect(Date.parse(String(finished.completedAt))).toBeGreaterThanOrEqual(Date.parse(String(finished.startedAt)));
});
it('records resolved storage errors as failed upload phases and preserves the existing cause', async () => {
  const { AnalysisUploads } = await import('@/server/storage/uploads');
  const { default: sharp } = await import('sharp');
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const storageError={message:'private storage error'};
  const client={storage:{from:()=>({upload:async()=>({error:storageError})})}};
  const rows:Array<Record<string,unknown>>=[];
  const recorder=new PhotoTimingRecorder({enabled:true,write:async batch=>{rows.push(...batch);}});
  const uploads=new AnalysisUploads(client as never);
  await expect(runPhotoTimingJob(recorder,()=>withPhotoTiming('photo',()=>uploads.upload('00000000-0000-4000-8000-000000000001',{name:'photo',type:'image/png',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer})))).rejects.toMatchObject({message:'Could not store analysis upload',cause:storageError});
  expect(rows.find(row=>row.phase==='upload'&&row.state==='failed')).toMatchObject({errorCode:'phase_failed'});
  expect(rows.find(row=>row.phase==='upload'&&row.state==='complete')).toBeUndefined();
  expect(JSON.stringify(rows)).not.toContain('private storage error');
});
