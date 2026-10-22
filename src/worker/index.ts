import type { AnalysisJob } from "@/server/repositories/jobs";

const DEFAULT_LEASE_SECONDS = 60;
const IDLE_WAIT_MS = 1_000;

export interface WorkerLoopDependencies {
  workerId: string;
  leaseSeconds?: number;
  lease(workerId: string, leaseSeconds: number): Promise<AnalysisJob | null>;
  process(job: AnalysisJob): Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runWorkerLoop(deps: WorkerLoopDependencies, signal: AbortSignal): Promise<void> {
  const idleWait = deps.wait ?? wait;

  while (!signal.aborted) {
    const job = await deps.lease(deps.workerId, deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS);

    if (job) {
      await deps.process(job);
      continue;
    }

    if (!signal.aborted) await idleWait(IDLE_WAIT_MS);
  }
}

export async function runUntilSigterm(deps: WorkerLoopDependencies): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);

  try {
    await runWorkerLoop(deps, controller.signal);
  } finally {
    process.off("SIGTERM", stop);
  }
}

/** Resolve the website-only stage here so the service worker entry point stays unchanged. */
export async function executeBackgroundCheckJob(job: AnalysisJob) {
 const [{parseApplicationEnv},{getBackgroundCheck,saveBackgroundCheck},{createBackgroundCheckStage},{AnalysisUploads}]=await Promise.all([
  import("@/config/application"),import("@/server/repositories/background-checks"),import("@/analysis/background-check-stage"),import("@/server/storage/uploads"),
 ]);
 const {createClient}=await import("@supabase/supabase-js");
 const env=parseApplicationEnv(process.env);
 const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
 const {data,error}=await client.from("analysis_inputs").select("service_job_id").eq("analysis_id",job.analysisId).single();
 if(error || !data?.service_job_id)throw new Error("Could not load background check input");
 return createBackgroundCheckStage({getBackgroundCheck:id=>getBackgroundCheck(id,client),saveBackgroundCheck:row=>saveBackgroundCheck(row,client),uploads:new AnalysisUploads(client)})({analysisId:job.analysisId,serviceJobId:data.service_job_id});
}

export async function deferJob(job:AnalysisJob,workerId:string,until:Date):Promise<void> {
 const {parseApplicationEnv}=await import("@/config/application");
 const {createClient}=await import("@supabase/supabase-js");
 const env=parseApplicationEnv(process.env);
 const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
 const {data,error}=await client.rpc("defer_analysis_job",{p_job_id:job.id,p_worker_id:workerId,p_available_at:until.toISOString()});
 if(error || !data?.[0]) {
  const failure=new Error("Could not defer analysis job");
  if(!error || error.message==='analysis job active lease not found for worker')throw Object.assign(failure,{leaseLost:true});
  throw failure;
 }
}
