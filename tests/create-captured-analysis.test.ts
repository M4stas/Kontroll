import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createCapturedAnalysisHandler } from '@/features/submission/captured-analysis';
import { cookieName, issueAccess } from '@/server/access';
process.env.ANALYSIS_COOKIE_SECRET='test-cookie-secret-with-at-least-32-chars';
const req = (authorized=true)=>new NextRequest('http://localhost/api/listings/j1/analysis',{method:'POST',headers:{origin:'http://localhost',host:'localhost','content-type':'application/json',...(authorized ? {cookie:`${cookieName('j1')}=${issueAccess('j1',undefined,'https://www.auto24.ee/soidukid/123')}`}:{})},body:JSON.stringify({locale:'en',pastedText:'Make: Volvo'})});
it('denies capture analysis before fetching service data or creating a report',async()=>{
 const create=vi.fn();const service=vi.fn();
 const result=await createCapturedAnalysisHandler({create,service})(req(false),{params:Promise.resolve({jobId:'j1'})});
 expect(result.status).toBe(401);expect(service).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
});
it('creates a private report from the existing failed service job and buyer fallback',async()=>{
 const create=vi.fn().mockResolvedValue({publicId:'public1'});
 const service=vi.fn().mockResolvedValue({job_id:'j1',status:'failed',submitted_at:'2026-09-30T10:00:00Z',parsed_at:null,listing:null,error:{code:'access_blocked',message:'blocked'},warnings:[]});
 const result=await createCapturedAnalysisHandler({create,service})(req(),{params:Promise.resolve({jobId:'j1'})});
 expect(result.status).toBe(201);expect(service).toHaveBeenCalledWith('j1');
 expect(create).toHaveBeenCalledWith(expect.objectContaining({serviceJobId:'j1',locale:'en',pastedText:'Make: Volvo',captureSnapshot:expect.objectContaining({type:'fallback_required'})}));
 expect((await result.json()).url).toMatch(/^\/en\/r\/public1#access=/);
 expect(result.headers.get('cache-control')).toBe('private, no-store');
});

it('accepts the browser Host origin behind a Next production proxy',async()=>{
 const request=req();
 const proxied=new NextRequest('http://localhost:3000/api/listings/j1/analysis',{method:'POST',headers:{...Object.fromEntries(request.headers),host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000'},body:JSON.stringify({locale:'en'})});
 const create=vi.fn().mockResolvedValue({publicId:'public1'});
 const service=vi.fn().mockResolvedValue({job_id:'j1',status:'failed',listing:null,parsed_at:null,error:{code:'access_blocked'},warnings:[]});
 expect((await createCapturedAnalysisHandler({create,service})(proxied,{params:Promise.resolve({jobId:'j1'})})).status).toBe(201);
});

it.each(['queued','running'])('rejects %s capture without creating a report',async(status)=>{
 const create=vi.fn();const service=vi.fn().mockResolvedValue({job_id:'j1',status});
 expect((await createCapturedAnalysisHandler({create,service})(req(),{params:Promise.resolve({jobId:'j1'})})).status).toBe(409);
 expect(create).not.toHaveBeenCalled();
});
it.each([{origin:'https://evil.test',body:{locale:'en'},status:403},{origin:'http://localhost',body:{locale:'en',model:'override'},status:400}])('rejects cross-origin and malformed controls',async({origin,body,status})=>{
 const create=vi.fn();const service=vi.fn();const initial=req();
 const request=new NextRequest(initial.url,{method:'POST',headers:{...Object.fromEntries(initial.headers),origin},body:JSON.stringify(body)});
 expect((await createCapturedAnalysisHandler({create,service})(request,{params:Promise.resolve({jobId:'j1'})})).status).toBe(status);
 expect(service).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
});
it('rejects a capture returned for a different private job',async()=>{
 const create=vi.fn();const service=vi.fn().mockResolvedValue({job_id:'other',status:'failed',listing:null,parsed_at:null,error:{code:'access_blocked'},warnings:[]});
 expect((await createCapturedAnalysisHandler({create,service})(req(),{params:Promise.resolve({jobId:'j1'})})).status).toBe(503);
 expect(create).not.toHaveBeenCalled();
});

it.each(['model','provider','prompt','system','reasoning','DATA_REVIEW_MODEL','configuration'])('rejects captured analysis control %s before service or creation',async field=>{
 const original=req();
 const request=new NextRequest(original.url,{method:'POST',headers:original.headers,body:JSON.stringify({locale:'en',pastedText:'Make: Volvo',[field]:{model:'evil'}})});
 const create=vi.fn();const service=vi.fn();
 const response=await createCapturedAnalysisHandler({create,service})(request,{params:Promise.resolve({jobId:'j1'})});
 expect(response.status).toBe(400);expect(create).not.toHaveBeenCalled();expect(service).not.toHaveBeenCalled();
});
