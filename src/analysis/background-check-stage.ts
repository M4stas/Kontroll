import { createHash } from 'node:crypto';
import { startBackgroundCheck,readBackgroundCheck,downloadBackgroundCheckPdf,expireBackgroundCheck,MAX_BACKGROUND_CHECK_BYTES,type WebsiteBackgroundCheckState } from '@/listings/background-check';
import type { AnalysisUploads } from '@/server/storage/uploads';
import type { BackgroundCheckRecord } from '@/server/repositories/background-checks';
import type { StageExecutionResult } from './stages';
interface Dependencies {
 getBackgroundCheck(analysisId:string):Promise<BackgroundCheckRecord|null>;
 saveBackgroundCheck(record:BackgroundCheckRecord):Promise<void>;
 uploads:Pick<AnalysisUploads,'upload'>;
 startBackgroundCheck?:typeof startBackgroundCheck;
 readBackgroundCheck?:typeof readBackgroundCheck;
 downloadBackgroundCheckPdf?:typeof downloadBackgroundCheckPdf;
 now?:()=>Date;
}
export function createBackgroundCheckStage(deps:Dependencies) {
 return async ({analysisId,serviceJobId}:{analysisId:string;serviceJobId:string}):Promise<StageExecutionResult>=>{
  const existing=await deps.getBackgroundCheck(analysisId);
  if(existing && existing.status!=='not_requested' && existing.status!=='pending' && !(existing.status==='fetched'&&!existing.storage_key))return {};
  const now=(deps.now??(()=>new Date()))();
  let state:WebsiteBackgroundCheckState;
  if(existing && expireBackgroundCheck(existing,now.getTime()).status==='unavailable')state=expireBackgroundCheck(existing,now.getTime());
  else {
   try {
    state=await (existing && existing.status!=='not_requested' ? deps.readBackgroundCheck??readBackgroundCheck : deps.startBackgroundCheck??startBackgroundCheck)(serviceJobId);
   } catch {
    state={status:'unavailable',requested_at:existing?.requested_at??now.toISOString(),searched_by:existing?.searched_by??null,reason:'site_changed',fetched_at:null,size_bytes:null,sha256:null};
   }
  }
  if(state.status==='not_requested')state={...state,status:'unavailable',reason:'site_changed',requested_at:now.toISOString()};
  state=expireBackgroundCheck(state,now.getTime());
  let storageKey:string|null=null;
  if(state.status==='fetched'){
   let bytes:Uint8Array<ArrayBuffer>;
   try {
    bytes=await (deps.downloadBackgroundCheckPdf??downloadBackgroundCheckPdf)(serviceJobId);
    if(bytes.byteLength>MAX_BACKGROUND_CHECK_BYTES || bytes.byteLength!==state.size_bytes || createHash('sha256').update(bytes).digest('hex')!==state.sha256)throw new Error('Invalid PDF');
   }catch{
    state={...state,status:'unavailable',reason:'pdf_rejected',fetched_at:null,size_bytes:null,sha256:null};
   }
   if(state.status==='fetched'){
    try {
     const upload=await deps.uploads.upload(analysisId,{name:'transpordiamet.pdf',type:'application/pdf',size:bytes!.byteLength,arrayBuffer:async()=>bytes!.slice().buffer},{contentAddressed:true});
     storageKey=upload.storageKey;
    }catch(error){
     // Validation errors are permanent; storage failures must retry the stage.
     if(error instanceof Error && (error.message==='Could not store analysis upload'))throw error;
     state={...state,status:'unavailable',reason:'pdf_rejected',fetched_at:null,size_bytes:null,sha256:null};
    }
   }
  }
  await deps.saveBackgroundCheck({...state,analysis_id:analysisId,service_job_id:serviceJobId,storage_key:storageKey,updated_at:now.toISOString()});
  if(state.status==='pending'){
   const deadline=Date.parse(state.requested_at!)+240000;
   return {deferUntil:new Date(Math.min(now.getTime()+3000,deadline))};
  }
  return {};
 };
}
