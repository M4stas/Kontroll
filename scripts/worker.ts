import { getBackgroundCheck } from "@/server/repositories/background-checks";
import { PhotoTimingsRepository } from "@/server/repositories/photo-timings";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { parseWorkerEnv } from "@/config/application";
import { createStageHandlers } from "@/analysis/pipeline";
import type { ListingAdapter } from "@/listings/adapter";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";
import { prepareListingPhotos, downloadListingPhoto } from "@/listings/photos";
import { AnalysisUploads } from "@/server/storage/uploads";
import { runUntilSigterm } from "@/worker";
import { ReviewExecutionsRepository } from "@/server/repositories/review-executions";
import { issueInsightImageCapability, createInsightImageCapabilityVerifier } from "@/insights/image-capability";
import { processJob } from "@/worker/process-job";
import { createWorkerLease, parseWorkerArgs } from "@/worker/created-after";

nextEnv.loadEnvConfig(process.cwd());

const createdAfter = parseWorkerArgs(process.argv.slice(2));
const env = parseWorkerEnv(process.env);

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const jobs = new JobsRepository(client);
const uploads = new AnalysisUploads(client);
const photoTimings = new PhotoTimingsRepository(client, env.WORKER_ID);
const stages = createStageHandlers({
  photoTimings: { enabled: env.LIVE_DIAGNOSTICS_ENABLED, write: (job, spans, signal) => photoTimings.write(job, spans, signal) },
  prepareListingPhotos: (analysisId, urls) => prepareListingPhotos(analysisId, urls, {download: downloadListingPhoto, upload:(id,file)=>uploads.upload(id,file,{contentAddressed:true})}),
  workerId:env.WORKER_ID,
  reviewExecutions:new ReviewExecutionsRepository(client),
  getBackgroundCheck: id => getBackgroundCheck(id, client),
  insightImageBoundary:{imageUrlVerifier:createInsightImageCapabilityVerifier(env.ANALYSIS_COOKIE_SECRET),allowedStorageOrigins:[new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin]},
  reviewImageCapability:async(analysisId,evidenceId,storageKey,contentHash)=>{
    if(await uploads.getStoredContentHash(analysisId,storageKey)!==contentHash)throw new Error('image_content_changed');
    return issueInsightImageCapability({analysisId,evidenceId,storageKey,...await uploads.createSignedRead(analysisId,storageKey)},env.ANALYSIS_COOKIE_SECRET);
  },
  analyses: new AnalysesRepository(client),
  evidence: new EvidenceRepository(client),
  listingAdapter: {canHandle:()=>false, capture: async ({url})=>({type:"fallback_required",reason:"fetch_disabled",listingUrl:url.href})} satisfies ListingAdapter,
  insightEnvironment: process.env,
});

console.log(`worker ${env.WORKER_ID} ready${createdAfter ? `, reports created at or after ${createdAfter}` : ""}`);
try {
  await runUntilSigterm({
    workerId: env.WORKER_ID,
    lease: createWorkerLease(client, jobs, createdAfter),
    process: (job) => processJob(job, { workerId: env.WORKER_ID, jobs, stages }),
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
