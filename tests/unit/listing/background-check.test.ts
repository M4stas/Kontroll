import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readBackgroundCheck, startBackgroundCheck, downloadBackgroundCheckPdf } from '@/listings/background-check';
const empty = {requested_at:null,searched_by:null,reason:null,fetched_at:null,size_bytes:null,sha256:null};
beforeEach(() => {vi.stubEnv('AUTO24_SERVICE_URL','https://service.test');vi.stubEnv('AUTO24_SERVICE_API_KEY','fake-key');vi.stubEnv('ANALYSIS_COOKIE_SECRET','background-check-preview-secret-32chars');vi.useFakeTimers({now:new Date('2026-10-22T12:00:00Z')});});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it.each(['not_requested','pending','fetched','not_found','skipped','unavailable'])('accepts %s', async status => {
 const state = {...empty,status,requested_at:status==='not_requested'?null:'2026-10-22T12:00:00Z',reason:status==='skipped'?'no_identity':status==='unavailable'?'blocked':null,...(status==='fetched'?{fetched_at:'2026-10-22T12:00:00Z',size_bytes:10,sha256:'a'.repeat(64)}:{})};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(state)));
 expect(await readBackgroundCheck('fake-job')).toEqual(state);
});
it('maps refusal to not_requested and uses the API key',async()=>{const fetch=vi.fn().mockResolvedValue(new Response(null,{status:409}));vi.stubGlobal('fetch',fetch);expect((await startBackgroundCheck('fake-job')).status).toBe('not_requested');expect(fetch.mock.calls[0]![1]).toMatchObject({method:'POST',headers:{'X-API-Key':'fake-key'}});});
it('expires pending at its deadline',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...empty,status:'pending',requested_at:'2026-10-22T11:56:00Z'})));expect(await readBackgroundCheck('fake-job')).toMatchObject({status:'unavailable',reason:'timeout'});});
it('rejects an inconsistent payload',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...empty,status:'fetched'})));await expect(readBackgroundCheck('fake-job')).rejects.toThrow('invalid_service_response');});
it('returns not_started for a network failure',async()=>{vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));expect((await startBackgroundCheck('fake-job')).status).toBe('not_started');});
it('times out',async()=>{vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))));const pending=readBackgroundCheck('fake-job');await vi.advanceTimersByTimeAsync(10000);expect((await pending).status).toBe('not_started');});
it('downloads PDF bytes',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('%PDF-fake',{headers:{'Content-Type':'application/pdf'}})));expect(new TextDecoder().decode(await downloadBackgroundCheckPdf('fake-job'))).toBe('%PDF-fake');});

it('loads in a plain worker process',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','--eval',"import('./src/analysis/background-check-stage.ts')"],{cwd:process.cwd(),encoding:'utf8'});
 expect(result.stderr).toBe('');
 expect(result.status).toBe(0);
});
