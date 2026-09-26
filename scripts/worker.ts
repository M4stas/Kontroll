import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createStageHandlers } from "@/analysis/pipeline";
import { Auto24ListingAdapter } from "@/listings/auto24";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";
import { ResearchRepository } from "@/server/repositories/research";
import { createWorkerResearchProvider } from "@/research/worker-provider";
import { runUntilSigterm } from "@/worker";
import { processJob } from "@/worker/process-job";

nextEnv.loadEnvConfig(process.cwd());

const env = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANALYSIS_COOKIE_SECRET: z.string().min(32),
  WORKER_ID: z.string().min(1),
  AUTO24_FETCH_ENABLED: z.enum(["true", "false"]).default("true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_INSIGHT_MODEL: z.string().optional(),
}).parse(process.env);

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const jobs = new JobsRepository(client);
const stages = createStageHandlers({
  analyses: new AnalysesRepository(client),
  evidence: new EvidenceRepository(client),
  listingAdapter: new Auto24ListingAdapter({ fetchEnabled: env.AUTO24_FETCH_ENABLED === "true" }),
  researchProvider: createWorkerResearchProvider(new ResearchRepository(client)),
  insightEnvironment: env,
});

try {
  await runUntilSigterm({
    workerId: env.WORKER_ID,
    lease: (workerId, leaseSeconds) => jobs.lease(workerId, leaseSeconds),
    process: (job) => processJob(job, { workerId: env.WORKER_ID, jobs, stages }),
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
