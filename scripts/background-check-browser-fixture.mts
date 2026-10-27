import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { AnalysesRepository } from '@/server/repositories/analyses';
import { EvidenceRepository } from '@/server/repositories/evidence';
import { JobsRepository } from '@/server/repositories/jobs';
import { ReviewExecutionsRepository } from '@/server/repositories/review-executions';
import { AnalysisUploads } from '@/server/storage/uploads';
import { createAccessToken } from '@/server/access/tokens';
import { createStageHandlers } from '@/analysis/pipeline';
import { createBackgroundCheckStage } from '@/analysis/background-check-stage';
import { getBackgroundCheckWithText, getBackgroundCheck, saveBackgroundCheck, reconcileBackgroundCheck } from '@/server/repositories/background-checks';
import { AnalysisReportSchema } from '@/domain/schemas';
import { processJob } from '@/worker/process-job';

const directory = process.env.BROWSER_FIXTURE_DIRECTORY ?? `${process.cwd()}/.superpowers/sdd/2026-10-22-transpordiamet-background-check/`;
const stateFile = `${directory}browser-state.json`;
const output = execFileSync('pnpm', ['dlx', 'supabase', 'status', '-o', 'env'], {encoding:'utf8',stdio:['ignore','pipe','ignore']});
const values = Object.fromEntries(output.trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),JSON.parse(line.slice(index+1))];}));
process.env.NEXT_PUBLIC_SUPABASE_URL = values.API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
process.env.ANALYSIS_COOKIE_SECRET = 'checkpoint-12-browser-fixture-secret-32chars';
process.env.AUTO24_FETCH_ENABLED = 'false';
const client = createClient(values.API_URL,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{autoRefreshToken:false,persistSession:false}});
const analyses = new AnalysesRepository(client);
const evidence = new EvidenceRepository(client);
const jobs = new JobsRepository(client);
const executions = new ReviewExecutionsRepository(client);
const workerId = 'checkpoint-12-browser-fixture';
const capabilities = {responses:true,text:true,structuredOutput:true,imageInput:true,efforts:[]};
const stages = createStageHandlers({analyses,evidence,reviewExecutions:executions,workerId,
  listingAdapter:{canHandle:()=>true,capture:async()=>{throw Error('Fixture cannot fetch listings');}},
  insightEnvironment:{OPENAI_API_KEY:'fixture-only',DATA_REVIEW_MODEL:'fixture-model',DATA_REVIEW_CAPABILITIES:JSON.stringify({openai:{'fixture-model':capabilities}})},
  dataReviewer:()=>({review:async input=>({schemaVersion:1,observations:input.pass==='final'&&input.sourceRecords.some(record=>record.kind==='official_record')?[{
    id:'synthetic-official-record',evidenceIds:[input.sourceRecords.find(record=>record.kind==='official_record')!.evidenceId],category:'official_history',title:input.locale==='et'?'Ametlik taustakontroll on kaasatud':'Official background check included',severity:'context',explanation:'Generated test PDF is included as official evidence.',recommendedAction:{kind:'inspection_task',title:'Check the record',instructions:'Compare the generated record during inspection.'},confidence:0.8,
  }]:[],warnings:[]})}),
  getBackgroundCheck:id=>getBackgroundCheckWithText(id,client),
} as Parameters<typeof createStageHandlers>[0]);
async function drain(id:string) {
  for(let count=0;count<25;count++) {
    const job=await jobs.leaseForAnalysis(workerId,60,id);
    if(!job) {
      // A fetched PDF child waits for a deferred parent enrich to finish.
      // Empty leases do not mean that this analysis has no scheduled work.
      const background=await getBackgroundCheck(id,client);
      if(background?.status!=='fetched')return;
      const current=await client.from('analyses').select('current_run_id').eq('id',id).single();
      if(current.error)throw Error('Fixture could not inspect current run');
      const pending=await client.from('analysis_jobs').select('id').eq('analysis_id',id).eq('run_id',current.data.current_run_id).in('status',['queued','leased']);
      if(pending.error)throw Error('Fixture could not inspect queued jobs');
      if(!pending.data?.length)return;
      await new Promise(resolve=>setTimeout(resolve,500));
      continue;
    }
    await processJob(job,{workerId,jobs,stages});
  }
  throw Error('Fixture queue did not settle');
}
function pdf(text:string) {
  const content=`BT /F1 12 Tf 10 100 Td (${text}) Tj ET\n`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >> stream\n${content}endstream`];
  let document='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(document));document+=`${index+1} 0 obj ${object} endobj\n`;});
  const xref=Buffer.byteLength(document);document+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(document));
}
const mode=process.argv[2];
if(mode==='init') {
  const token=createAccessToken();
  const {publicId}=await analyses.create({accessTokenHash:token.hash,locale:'en',listingUrl:'https://example.test/checkpoint-12',inputType:'url',vin:'WVWZZZ1KZAW000001'});
  const id=(await analyses.loadAnalysisId(publicId))!;
  await client.from('analysis_inputs').update({capture_snapshot:{type:'snapshot',marketplace:'auto24',sourceId:'synthetic-listing',sourceUrl:'https://example.test/checkpoint-12',capturedAt:new Date().toISOString(),contentHash:'synthetic-listing-hash',description:'Toyota Avensis 2017. Synthetic browser verification.',imageUrls:[],screenshotRefs:[],facts:[{key:'make',value:'Toyota',sourceId:'synthetic-listing',verification:'unverified',confidence:0.5},{key:'vin',value:'WVWZZZ1KZAW000001',sourceId:'synthetic-listing',verification:'unverified',confidence:0.5}],claims:[],warnings:[]}}).eq('analysis_id',id);
  const requestedAt=new Date().toISOString();
  await saveBackgroundCheck({analysis_id:id,service_job_id:'synthetic-browser-job',status:'pending',requested_at:requestedAt,searched_by:'vin',reason:null,fetched_at:null,size_bytes:null,sha256:null,storage_key:null},client);
  writeFileSync(stateFile,JSON.stringify({id,publicId,token:token.raw}),{mode:0o600});
  await drain(id);
  writeFileSync(`${directory}manual.pdf`,pdf('Synthetic buyer document, inspection record.'));
  console.log(`http://localhost:3112/en/r/${publicId}#access=${token.raw}`);
} else {
  const state=JSON.parse(readFileSync(stateFile,'utf8'));
  if(mode==='fetch') {
    const bytes=pdf('VIN WVWZZZ1KZAW000002. Synthetic official inspection record.');
    const existing=(await getBackgroundCheck(state.id,client))!;
    const fetched={...existing,status:'fetched' as const,reason:null,fetched_at:new Date().toISOString(),size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    const execute=createBackgroundCheckStage({getBackgroundCheck:id=>getBackgroundCheck(id,client),saveBackgroundCheck:record=>saveBackgroundCheck(record,client),uploads:new AnalysisUploads(client),readBackgroundCheck:async()=>fetched,downloadBackgroundCheckPdf:async()=>bytes,reconcileBackgroundCheck:id=>reconcileBackgroundCheck(id,client)});
    await execute({analysisId:state.id,serviceJobId:'synthetic-browser-job'});
  } else if(mode==='drain') await drain(state.id);
  else if(mode==='missing') {const existing=(await getBackgroundCheck(state.id,client))!;await saveBackgroundCheck({...existing,status:'unavailable',reason:'timeout',storage_key:null,fetched_at:null,size_bytes:null,sha256:null},client);}
  else if(mode==='status') {
    const report=await analyses.loadReport(state.publicId);
    console.log(JSON.stringify({schemaValid:AnalysisReportSchema.safeParse(report).success,status:report?.status,activity:report?.activity,review:report?.review,findings:report?.findings.map(f=>f.title),sourceCount:Object.keys(report?.sources??{}).length}));
  }
  console.log(`Fixture ${mode} finished`);
}
