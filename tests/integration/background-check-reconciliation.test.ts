import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// Real PostgreSQL sessions: the shared stack is never stopped or reset.
const container = "supabase_db_used-car-prototype";
const args = ["exec", "-i", container, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c"];
const execute = promisify(execFile);
const ids: string[] = [];
function sql(query: string) { return execFileSync("docker", [...args, query], { encoding: "utf8" }).trim(); }
async function session(query: string) { return (await execute("docker", [...args, query])).stdout.trim(); }
function fixture() {
 const a=randomUUID(), r=randomUUID(); ids.push(a);
 sql(`insert into public.analyses(id,access_token_hash,locale) values('${a}','fixture','en');
 insert into public.analysis_runs(id,analysis_id,trigger,stage_states) values('${r}','${a}','initial','{"baseline_checks":{"status":"complete"},"research":{"status":"complete"}}');
 update public.analyses set current_run_id='${r}' where id='${a}';
 insert into public.review_run_snapshots(analysis_id,run_id,input_hash,snapshot) values('${a}','${r}',repeat('a',64),'{}');
 select public.save_analysis_background_check(jsonb_build_object('analysis_id','${a}','service_job_id','fixture','status','fetched','fetched_at',now(),'storage_key','fixture.pdf','size_bytes',10,'sha256',repeat('b',64),'text_content','Generated fixture'));`);
 return {a,r};
}
afterEach(()=>{for(const a of ids.splice(0))sql(`update public.analyses set current_run_id=null where id='${a}'; delete from public.analyses where id='${a}';`);});
describe("official PDF reconciliation PostgreSQL races",()=>{
 it("serializes concurrent retries into one child",async()=>{
  const {a}=fixture();
  const results=await Promise.all(Array.from({length:4},()=>session(`select public.reconcile_analysis_background_check('${a}')`)));
  const decisions=results.map(value=>JSON.parse(value) as {run_id:string;decision:string});
  expect(new Set(decisions.map(value=>value.run_id)).size).toBe(1);
  expect(decisions.every(value=>value.decision==='scheduled')).toBe(true);
  expect(sql(`select count(*) from public.analysis_runs where analysis_id='${a}'`)).toBe('2');
 });
 for(const kind of ['document','seller_answer'] as const)for(const first of ['official','manual'] as const)
 it(`retains ${kind} with ${first} holding the analysis lock first`,async()=>{
  const {a}=fixture();
  const reconcile=`select public.reconcile_analysis_background_check('${a}');`;
  const accept=`select * from public.accept_analysis_submission_group('${a}','${randomUUID()}','[{"kind":"${kind}","provided_by":"seller","text_content":"Generated manual fixture"${kind==='document'?',"mime_type":"application/pdf"':''}}]',array['enrich','assemble_report']);`;
  const leading=first==='official'?reconcile:accept, trailing=first==='official'?accept:reconcile;
  // Establish the first lock before the second connection begins.
  const running=session(`set application_name='pdf-race-${a}'; begin; select id from public.analyses where id='${a}' for update; select pg_sleep(1); ${leading} commit;`);
  let locked=false;
  for(let retry=0;retry<40;retry++){
   if(sql(`select exists(select 1 from pg_stat_activity where application_name='pdf-race-${a}' and wait_event='PgSleep')`)==='t'){locked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(locked).toBe(true);
  await Promise.all([running,session(trailing)]);
  const decision=JSON.parse(sql(reconcile)) as {run_id:string;evidence_id:string;source_snapshot_id:string};
  expect(sql(`select public.review_evidence_is_owned('${a}','${decision.run_id}',jsonb_build_object('id','${decision.evidence_id}','sourceId','${decision.source_snapshot_id}'))`)).toBe('t');
  expect(sql(`with recursive lineage as (select id,parent_run_id from public.analysis_runs where id='${decision.run_id}' union all select r.id,r.parent_run_id from public.analysis_runs r join lineage l on l.parent_run_id=r.id) select count(*) from public.submissions s join lineage l on l.id=s.run_id where s.analysis_id='${a}' and s.text_content='Generated manual fixture'`)).toBe('1');
  expect(sql(`select count(*) from public.analysis_jobs where analysis_id='${a}' and stage='background_check' and status='failed'`)).toBe('0');
 },20000);
});


describe("official PDF reconciliation SQL contract", () => {
 it("passes in a rolled-back transaction", () => {
  const contract = readFileSync(join(process.cwd(), "tests", "sql", "background-check-reconciliation.sql"), "utf8");
  expect(() => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], {
   input: `begin;\n${contract}\nrollback;\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  })).not.toThrow();
 });
});

describe("official PDF parent states", () => {
 for (const status of ['queued', 'leased', 'failed', 'missing'] as const) {
  it.each([false, true])(`handles ${status} parent enrich with snapshot=%s`, hasSnapshot => {
   const {a,r} = fixture();
   if (!hasSnapshot) sql(`delete from public.review_run_snapshots where run_id='${r}'`);
   if (status !== 'missing') sql(`insert into public.analysis_jobs(analysis_id,run_id,stage,idempotency_key,status,leased_by,lease_expires_at)
    values('${a}','${r}','enrich','${randomUUID()}','${status}',${status === 'leased' ? "'fixture',now()+interval '1 hour'" : 'null,null'});`);
   const decision = JSON.parse(sql(`select public.reconcile_analysis_background_check('${a}')`));
   expect(decision.decision).toBe(hasSnapshot ? 'scheduled' : 'pending');
   expect(sql(`select public.review_evidence_is_owned('${a}','${decision.run_id}',jsonb_build_object('id','${decision.evidence_id}','sourceId','${decision.source_snapshot_id}'))`)).toBe('t');
   expect(sql(`select count(*) from public.analysis_runs where analysis_id='${a}'`)).toBe(hasSnapshot ? '2' : '1');
   if (hasSnapshot) {
    expect(sql(`select trigger||':'||(review_reuse_run_id='${r}')::text from public.analysis_runs where id='${decision.run_id}'`)).toBe('background_update:true');
    expect(sql(`select count(*) from public.analysis_jobs where run_id='${decision.run_id}' and status='queued' and stage in ('enrich','assemble_report')`)).toBe('2');
   }
   if (status !== 'missing') expect(sql(`select status from public.analysis_jobs where run_id='${r}' and stage='enrich'`)).toBe(status);
  });
 }
 it('schedules one child after a committed final and a PDF fetched beyond the 240 second deadline', () => {
  const {a,r} = fixture();
  sql(`delete from public.analysis_background_checks where analysis_id='${a}';
   insert into public.review_executions(analysis_id,run_id,snapshot_id,pass,fingerprint,request_projection,result,result_hash,completed_at)
   select '${a}','${r}',id,'final',repeat('c',64),'{}','{"schemaVersion":1,"observations":[],"warnings":[]}',repeat('d',64),now()
   from public.review_run_snapshots where run_id='${r}';
   update public.analyses set status='complete' where id='${a}';
   select public.save_analysis_background_check(jsonb_build_object('analysis_id','${a}','service_job_id','fixture','status','fetched',
    'requested_at',now()-interval '241 seconds','fetched_at',clock_timestamp(),'storage_key','fixture.pdf','size_bytes',10,'sha256',repeat('b',64),'text_content','Generated fixture'));`);
  const decision = JSON.parse(sql(`select public.reconcile_analysis_background_check('${a}')`));
  expect(decision.decision).toBe('scheduled');
  expect(sql(`select status from public.analyses where id='${a}'`)).toBe('queued');
  expect(sql(`select result_hash from public.review_executions where run_id='${r}' and pass='final'`)).toBe('d'.repeat(64));
  expect(JSON.parse(sql(`select public.reconcile_analysis_background_check('${a}')`)).run_id).toBe(decision.run_id);
  expect(sql(`select count(*) from public.analysis_runs where analysis_id='${a}'`)).toBe('2');
 });
});
