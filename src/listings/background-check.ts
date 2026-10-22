import { z } from 'zod';
import { ApiError } from '@/server/errors';
export const SERVICE_TIMEOUT_MS = 10000;
function serviceConfig() {
 try {
  const url = new URL(process.env.AUTO24_SERVICE_URL ?? '');
  const key = process.env.AUTO24_SERVICE_API_KEY;
  const secret = process.env.ANALYSIS_COOKIE_SECRET;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !key?.trim() || !secret || secret.length < 32) throw new Error();
  return {origin: url.origin, key};
 } catch { throw new ApiError('configuration_error', 503); }
}
export const BACKGROUND_CHECK_SECONDS = 240;
export const MAX_BACKGROUND_CHECK_BYTES = 12 * 1024 * 1024;
const reasons = z.enum(['no_identity','captcha_failed','blocked','timeout','pdf_rejected','site_changed','browser_crash']);
export const backgroundCheckSchema = z.object({
 status:z.enum(['not_requested','pending','fetched','not_found','skipped','unavailable']),
 requested_at:z.iso.datetime({offset:true}).nullable(), searched_by:z.enum(['reg_number','vin']).nullable(),
 reason:reasons.nullable(), fetched_at:z.iso.datetime({offset:true}).nullable(),
 size_bytes:z.number().int().positive().max(MAX_BACKGROUND_CHECK_BYTES).nullable(), sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).superRefine((state,ctx)=>{
 const fetched=state.status==='fetched';
 if ((state.requested_at===null)!==(state.status==='not_requested') || [state.fetched_at,state.size_bytes,state.sha256].some(value=>(value!==null)!==fetched)
 || (state.status==='skipped'?state.reason!=='no_identity':state.status==='unavailable'?state.reason===null||state.reason==='no_identity':state.reason!==null)) ctx.addIssue({code:'custom',message:'Invalid background check state'});
});
export type BackgroundCheckState = z.infer<typeof backgroundCheckSchema>;
export type WebsiteBackgroundCheckState = Omit<BackgroundCheckState,'status'> & {status:BackgroundCheckState['status']|'not_started'};
export function emptyBackgroundCheck(status:'not_requested'|'not_started'):WebsiteBackgroundCheckState {return {status,requested_at:null,searched_by:null,reason:null,fetched_at:null,size_bytes:null,sha256:null};}
export function expireBackgroundCheck(state:WebsiteBackgroundCheckState,now=Date.now()):WebsiteBackgroundCheckState {
 return state.status==='pending' && state.requested_at && now>=Date.parse(state.requested_at)+BACKGROUND_CHECK_SECONDS*1000 ? {...state,status:'unavailable',reason:'timeout'} : state;
}
async function request(jobId:string,method:'GET'|'POST',pdf=false):Promise<WebsiteBackgroundCheckState|Uint8Array<ArrayBuffer>> {
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),SERVICE_TIMEOUT_MS);
 try {
  const {origin,key}=serviceConfig();
  const response=await fetch(`${origin}/v1/jobs/${encodeURIComponent(jobId)}/background-check${pdf?'/pdf':''}`,{method,headers:{'X-API-Key':key},cache:'no-store',redirect:'error',signal:controller.signal});
  if(response.status===409&&!pdf)return emptyBackgroundCheck('not_requested');
  if(!response.ok)throw new ApiError('service_unavailable',503);
  if(pdf){
   if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/pdf' || Number(response.headers.get('content-length'))>MAX_BACKGROUND_CHECK_BYTES)throw new ApiError('invalid_service_response',502);
   const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();
   if(!reader)throw new ApiError('invalid_service_response',502);
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BACKGROUND_CHECK_BYTES){await reader.cancel();throw new ApiError('invalid_service_response',502);}chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }
  let payload:unknown;try{payload=await response.json();}catch{if(controller.signal.aborted)return emptyBackgroundCheck('not_started');throw new ApiError('invalid_service_response',502);}
  const parsed=backgroundCheckSchema.safeParse(payload);if(!parsed.success)throw new ApiError('invalid_service_response',502);
  return expireBackgroundCheck(parsed.data);
 }catch(error){if(error instanceof ApiError)throw error;if(pdf)throw new ApiError('service_unavailable',503);return emptyBackgroundCheck('not_started');}
 finally{clearTimeout(timer);}
}
export async function startBackgroundCheck(jobId:string):Promise<WebsiteBackgroundCheckState>{return await request(jobId,'POST') as WebsiteBackgroundCheckState;}
export async function readBackgroundCheck(jobId:string):Promise<WebsiteBackgroundCheckState>{return await request(jobId,'GET') as WebsiteBackgroundCheckState;}
export async function downloadBackgroundCheckPdf(jobId:string):Promise<Uint8Array<ArrayBuffer>>{return await request(jobId,'GET',true) as Uint8Array<ArrayBuffer>;}
