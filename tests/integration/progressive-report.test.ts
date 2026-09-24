import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStageHandlers } from "@/analysis/pipeline";
import type { InsightProvider } from "@/insights/provider";
import type { ListingAdapter, ListingSnapshot } from "@/listings/adapter";
import type { ResearchProvider } from "@/research/provider";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";
import { processJob } from "@/worker/process-job";

function localServiceCredentials(): { url: string; key: string } {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const key = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  if (!values.API_URL || !key) throw new Error("Local Supabase service credentials are unavailable");
  return { url: values.API_URL, key };
}

const capturedAt = "2026-09-18T12:00:00.000Z";

function snapshot(): ListingSnapshot {
  return {
    type: "snapshot",
    marketplace: "auto24",
    sourceId: "listing-source",
    sourceUrl: "https://www.auto24.ee/soidukid/123456",
    capturedAt,
    contentHash: "listing-content-hash",
    description: "Regularly serviced according to the seller.",
    imageUrls: [],
    screenshotRefs: [],
    facts: [
      { key: "make", value: "Toyota", sourceId: "listing-source", verification: "unverified", confidence: 0.5 },
      { key: "model", value: "Avensis", sourceId: "listing-source", verification: "unverified", confidence: 0.5 },
      { key: "year", value: "2017", sourceId: "listing-source", verification: "unverified", confidence: 0.5 },
    ],
    claims: [{ text: "Regularly serviced according to the seller.", sourceClass: "seller", verification: "unverified" }],
    warnings: [],
  };
}

describe("progressive report persistence", () => {
  let client: SupabaseClient;
  let analyses: AnalysesRepository;
  let evidence: EvidenceRepository;
  let jobs: JobsRepository;
  let serviceUrl: string;
  let serviceKey: string;
  const createdPublicIds = new Set<string>();

  beforeAll(() => {
    ({ url: serviceUrl, key: serviceKey } = localServiceCredentials());
    client = createClient(serviceUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    analyses = new AnalysesRepository(client);
    evidence = new EvidenceRepository(client);
    jobs = new JobsRepository(client);
  });

  afterEach(async () => {
    for (const publicId of createdPublicIds) {
      const { error } = await client.from("analyses").delete().eq("public_id", publicId);
      expect(error).toBeNull();
    }
    createdPublicIds.clear();
  });

  async function expectNoForeignQueuedJobs(analysisIds: string[]) {
    const { count, error } = await client.from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "leased"])
      .not("analysis_id", "in", `(${analysisIds.join(",")})`);
    expect(error).toBeNull();
    expect(count, "Global fairness lease requires no jobs from other analyses").toBe(0);
  }

  async function createWorkerPipeline(input: {
    insightProvider?: InsightProvider;
    workerNow?: Date;
  } = {}) {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    createdPublicIds.add(publicId);
    const { data: initial } = await client
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    if (!initial?.current_run_id) throw new Error("Expected initial run");

    const stages = createStageHandlers({
      analyses,
      evidence,
      listingAdapter: { canHandle: () => true, capture: async () => snapshot() },
      researchProvider: { research: async () => ({ summary: "Known maintenance context.", sourceRefs: [] }) },
      insightProvider: input.insightProvider,
      now: () => new Date(capturedAt),
    });
    const processNext = async (failCompletion = false) => {
      const leased = await jobs.leaseForAnalysis("progressive-worker", 60, initial.id);
      if (!leased) throw new Error("Expected queued worker stage");
      const workerJobs = failCompletion
        ? {
          enqueue: jobs.enqueue.bind(jobs),
          complete: async () => { throw new Error("completion write failed"); },
          fail: jobs.fail.bind(jobs),
          renew: jobs.renew.bind(jobs),
          retry: jobs.retry.bind(jobs),
        }
        : jobs;
      await processJob(leased, {
        workerId: "progressive-worker",
        jobs: workerJobs,
        stages,
        now: () => input.workerNow ?? new Date(capturedAt),
      });
      return leased;
    };
    return { publicId, initial, processNext, stages };
  }

  async function processThroughFinal(processNext: (failCompletion?: boolean) => Promise<{ stage: string }>) {
    for (let index = 0; index < 7; index += 1) await processNext();
  }

  it("leaves an older queued analysis untouched while processing its own worker stage", async () => {
    const older = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/older-queued",
    });
    createdPublicIds.add(older.publicId);
    const { data: olderAnalysis, error: olderError } = await client.from("analyses")
      .select("id").eq("public_id", older.publicId).single();
    expect(olderError).toBeNull();

    const pipeline = await createWorkerPipeline();
    const processed = await pipeline.processNext();
    expect(processed.analysisId).toBe(pipeline.initial.id);
    expect(processed.stage).toBe("capture_listing");
    const { data: olderJob, error: jobError } = await client.from("analysis_jobs")
      .select("status, attempts").eq("analysis_id", olderAnalysis!.id).single();
    expect(jobError).toBeNull();
    expect(olderJob).toMatchObject({ status: "queued", attempts: 0 });
  });

  // Catches the worker graph skipping the readable baseline and warning-only enrichment blocking completion.
  it("publishes through the worker, then completes with warning-only enrichment and policy confidence", async () => {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
    createdPublicIds.add(publicId);
    const { data: initial } = await client.from("analyses").select("id, current_run_id").eq("public_id", publicId).single();
    if (!initial?.current_run_id) throw new Error("Expected initial run");

    const listingAdapter: ListingAdapter = { canHandle: () => true, capture: async () => snapshot() };
    const researchProvider: ResearchProvider = {
      research: async () => ({ summary: "Known maintenance context.", sourceRefs: [] }),
    };
    const insightProvider: InsightProvider = {
      enrich: async () => ({
        schemaVersion: 1,
        sources: [],
        findings: [],
        imageObservations: [],
        warnings: [{ stage: "enrich", code: "schema_invalid", message: "No usable optional insight." }],
      }),
    };
    const stages = createStageHandlers({
      analyses,
      evidence,
      listingAdapter,
      researchProvider,
      insightProvider,
      now: () => new Date(capturedAt),
    });
    const processNext = async () => {
      const leased = await jobs.leaseForAnalysis("progressive-worker", 60, initial.id);
      if (!leased) throw new Error("Expected queued worker stage");
      await processJob(leased, { workerId: "progressive-worker", jobs, stages });
    };

    await processNext(); // capture_listing
    await processNext(); // normalize_identity
    await processNext(); // baseline_checks
    await processNext(); // assemble_report
    await expect(analyses.loadReport(publicId)).resolves.toMatchObject({
      status: "partial",
      findings: expect.any(Array),
      warnings: expect.arrayContaining(["research_pending", "enrich_pending"]),
    });

    await processNext(); // research
    await processNext(); // enrich
    await processNext(); // assemble_report

    const report = await analyses.loadReport(publicId);
    expect(report).toMatchObject({
      status: "complete",
      confidence: "low",
      verdict: "proceed_cautiously",
      warnings: expect.arrayContaining(["enrich_schema_invalid"]),
    });
    const { data: states } = await client
      .from("analysis_runs")
      .select("status, stage_states")
      .eq("id", initial.current_run_id)
      .single();
    expect(states).toMatchObject({ status: "complete", stage_states: {
      baseline_checks: { version: 1, status: "complete" },
      enrich: { version: 1, status: "complete" },
    } });
    const { count: assemblyJobs, error: assemblyJobError } = await client
      .from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .eq("analysis_id", initial.id)
      .eq("run_id", initial.current_run_id)
      .eq("stage", "assemble_report");
    expect(assemblyJobError).toBeNull();
    expect(assemblyJobs).toBe(1);
  });

  // Catches treating a terminal-but-unavailable optional insight provider as a permanently pending report dependency.
  it.each([
    ["a missing insight provider", undefined],
    ["a throwing insight provider", { enrich: async () => { throw new Error("provider unavailable"); } }],
  ] as const)("completes the deterministic report with safe warnings after %s", async (_label, insightProvider) => {
    const pipeline = await createWorkerPipeline({ insightProvider });

    await processThroughFinal(pipeline.processNext);

    await expect(analyses.loadReport(pipeline.publicId)).resolves.toMatchObject({
      status: "complete",
      warnings: expect.arrayContaining(["enrich_unavailable"]),
    });
    const { data: run } = await client
      .from("analysis_runs")
      .select("status, stage_states")
      .eq("id", pipeline.initial.current_run_id)
      .single();
    expect(run).toMatchObject({
      status: "complete",
      stage_states: { enrich: { version: 1, status: "unavailable", warnings: ["enrich_unavailable"] } },
    });
  });

  // Catches final persistence using the raw insight output after assembly has rejected unsupported important findings.
  it("never persists unsupported insight findings or their actions", async () => {
    const pipeline = await createWorkerPipeline({
      insightProvider: {
        enrich: async () => ({
          schemaVersion: 1,
          sources: [],
          findings: [{
            id: "unsupported-insight",
            category: "condition",
            severity: "important",
            title: "Unsupported insight",
            observation: "The provided proof does not exist in this run.",
            source: {
              id: "insight-source",
              url: "https://example.com/unsupported",
              title: "Unsupported source",
              sourceClass: "independent",
              applicability: "background",
              confidence: 0.8,
              observation: "Unsupported observation",
            },
            evidenceIds: ["missing-evidence-id"],
            recommendedAction: {
              kind: "inspection_task",
              title: "Inspect unsupported condition",
              instructions: "Verify the condition during inspection.",
            },
          }],
          imageObservations: [],
          warnings: [],
        }),
      },
    });

    await processThroughFinal(pipeline.processNext);

    const report = await analyses.loadReport(pipeline.publicId);
    expect(report).toMatchObject({ warnings: expect.arrayContaining(["finding_without_evidence"]) });
    expect(report?.findings).not.toContainEqual(expect.objectContaining({ title: "Unsupported insight" }));
    expect(report?.actions).not.toContainEqual(expect.objectContaining({ title: "Inspect unsupported condition" }));
    const [{ data: findings }, { data: actions }] = await Promise.all([
      client.from("findings").select("title").eq("analysis_id", pipeline.initial.id),
      client.from("actions").select("title").eq("analysis_id", pipeline.initial.id),
    ]);
    expect(findings).not.toContainEqual({ title: "Unsupported insight" });
    expect(actions).not.toContainEqual({ title: "Inspect unsupported condition" });
  });

  // Catches a delayed optional stage being overtaken by final assembly after the
  // initial readable report has already been published.
  it("waits for a retried enrichment before publishing the one final assembly", async () => {
    const pipeline = await createWorkerPipeline({
      workerNow: new Date(),
      insightProvider: {
        enrich: async (input) => ({
          schemaVersion: 1,
          sources: [],
          findings: [{
            id: "supported-insight",
            category: "condition",
            severity: "important",
            title: "Supported insight",
            observation: "The listing evidence needs verification.",
            source: {
              id: "insight-source",
              url: "https://example.com/supported",
              title: "Supported source",
              sourceClass: "independent",
              applicability: "background",
              confidence: 0.8,
              observation: "Supported observation",
            },
            evidenceIds: [input.evidence[0]?.id ?? "missing-evidence-id"],
            recommendedAction: {
              kind: "inspection_task",
              title: "Inspect supported condition",
              instructions: "Verify the condition during inspection.",
            },
          }],
          imageObservations: [],
          warnings: [],
        }),
      },
    });

    for (let index = 0; index < 5; index += 1) await pipeline.processNext();
    const retriedEnrich = await pipeline.processNext(true);
    expect(retriedEnrich.stage).toBe("enrich");
    await expect(jobs.leaseForAnalysis("backoff-verification-worker", 60, pipeline.initial.id)).resolves.toBeNull();
    const { error: makeRetryAvailable } = await client
      .from("analysis_jobs")
      .update({ available_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", retriedEnrich.id);
    expect(makeRetryAvailable).toBeNull();
    const retriedCompletion = await pipeline.processNext();
    expect(retriedCompletion.stage).toBe("enrich");
    const finalAssembly = await pipeline.processNext();
    expect(finalAssembly.stage).toBe("assemble_report");

    await expect(jobs.leaseForAnalysis("verification-worker", 60, pipeline.initial.id)).resolves.toBeNull();
    const [{ data: findings }, { data: actions }] = await Promise.all([
      client.from("findings").select("title").eq("analysis_id", pipeline.initial.id).eq("title", "Supported insight"),
      client.from("actions").select("title").eq("analysis_id", pipeline.initial.id).eq("title", "Inspect supported condition"),
    ]);
    expect(findings).toHaveLength(1);
    expect(actions).toHaveLength(1);
    const { count: assemblies, error: assemblyError } = await client
      .from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .eq("analysis_id", pipeline.initial.id)
      .eq("run_id", pipeline.initial.current_run_id)
      .eq("stage", "assemble_report");
    expect(assemblyError).toBeNull();
    expect(assemblies).toBe(1);
  });

  // Catches total stage ordering blocking the deliberately-readable first
  // assembly when optional initial research has already been queued.
  it("leases the first initial partial assembly while research and enrichment are pending", async () => {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/initial-partial",
    });
    createdPublicIds.add(publicId);
    const { data: initial, error: initialError } = await client
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    expect(initialError).toBeNull();
    if (!initial?.current_run_id) throw new Error("Expected initial run");

    const complete = { version: 1, status: "complete", output: {}, warnings: [], completedAt: capturedAt };
    const queued = await client.from("analysis_jobs").insert([
      { analysis_id: initial.id, run_id: initial.current_run_id, stage: "research", idempotency_key: `${initial.id}:${initial.current_run_id}:research` },
      { analysis_id: initial.id, run_id: initial.current_run_id, stage: "enrich", idempotency_key: `${initial.id}:${initial.current_run_id}:enrich` },
      { analysis_id: initial.id, run_id: initial.current_run_id, stage: "assemble_report", idempotency_key: `${initial.id}:${initial.current_run_id}:assemble_report` },
    ]);
    expect(queued.error).toBeNull();
    expect((await client.from("analysis_jobs").update({ status: "complete", completed_at: capturedAt })
      .eq("analysis_id", initial.id).eq("run_id", initial.current_run_id).eq("stage", "capture_listing")).error).toBeNull();
    // Keep the fixture ahead of jobs that another local process may enqueue after the guard.
    expect((await client.from("analysis_runs").update({
      stage_states: { capture_listing: complete, normalize_identity: complete, baseline_checks: complete },
      created_at: "0001-01-01T00:00:00+00:00",
    }).eq("id", initial.current_run_id)).error).toBeNull();

    await expectNoForeignQueuedJobs([initial.id]);
    const leased = await jobs.lease("initial-partial-worker", 60);
    expect(leased?.analysisId).toBe(initial.id);
    expect(leased?.stage).toBe("assemble_report");
  });

  // Catches the stale-read boundary where final run state becomes durable after the partial check but before job requeue.
  it("keeps a completed assembly closed when final state lands at the requeue boundary", async () => {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/atomic-requeue",
    });
    createdPublicIds.add(publicId);
    const { data: initial, error: initialError } = await client
      .from("analyses")
      .select("id, current_run_id")
      .eq("public_id", publicId)
      .single();
    expect(initialError).toBeNull();
    if (!initial?.current_run_id) throw new Error("Expected initial run");

    const partialState = {
      assemble_report: {
        version: 1,
        status: "complete",
        output: { status: "partial", advanceToResearch: true },
      },
    };
    const finalState = {
      assemble_report: {
        version: 1,
        status: "complete",
        output: { status: "complete", advanceToResearch: false },
      },
    };
    const { error: partialError } = await client
      .from("analysis_runs")
      .update({ stage_states: partialState })
      .eq("id", initial.current_run_id)
      .eq("analysis_id", initial.id);
    expect(partialError).toBeNull();
    await jobs.enqueue({ analysisId: initial.id, runId: initial.current_run_id, stage: "assemble_report" });
    const { error: completeError } = await client
      .from("analysis_jobs")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("analysis_id", initial.id)
      .eq("run_id", initial.current_run_id)
      .eq("stage", "assemble_report");
    expect(completeError).toBeNull();

    let finalized = false;
    const persistFinalState = async () => {
      if (finalized) return;
      finalized = true;
      const { error } = await client
        .from("analysis_runs")
        .update({ stage_states: finalState, status: "complete", completed_at: new Date().toISOString() })
        .eq("id", initial.current_run_id)
        .eq("analysis_id", initial.id);
      expect(error).toBeNull();
    };
    const racingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.includes("/rpc/requeue_partial_assembly_job")) await persistFinalState();
      const response = await globalThis.fetch(input, init);
      if (!finalized && method === "GET" && url.includes("/rest/v1/analysis_runs")) await persistFinalState();
      return response;
    };
    const racingClient = createClient(serviceUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: racingFetch },
    });

    await new JobsRepository(racingClient).enqueue({
      analysisId: initial.id,
      runId: initial.current_run_id,
      stage: "assemble_report",
    });

    const { data: assemblyJob, error: jobError } = await client
      .from("analysis_jobs")
      .select("status, completed_at")
      .eq("analysis_id", initial.id)
      .eq("run_id", initial.current_run_id)
      .eq("stage", "assemble_report")
      .single();
    expect(jobError).toBeNull();
    expect(finalized).toBe(true);
    expect(assemblyJob?.status).toBe("complete");
    expect(assemblyJob?.completed_at).not.toBeNull();
  });

  it("finishes after an optional research job exhausts its retries", async () => {
    const pipeline = await createWorkerPipeline({ workerNow: new Date() });
    for (let index = 0; index < 4; index += 1) await pipeline.processNext();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await jobs.leaseForAnalysis("exhausted-research-worker", 60, pipeline.initial.id);
      expect(job?.stage).toBe("research");
      if (!job) throw new Error("Missing research job");
      await processJob(job, {
        workerId: "exhausted-research-worker", jobs,
        stages: { ...pipeline.stages, research: async () => { throw Object.assign(new Error("research offline"), { transient: true }); } },
      });
      const { error } = await client.from("analysis_jobs")
        .update({ available_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", job.id);
      expect(error).toBeNull();
    }
    const { data: failedRun } = await client.from("analysis_runs").select("stage_states")
      .eq("id", pipeline.initial.current_run_id).single();
    expect(failedRun?.stage_states?.research).toMatchObject({ status: "unavailable" });
    expect((await pipeline.processNext()).stage).toBe("enrich");
    expect((await pipeline.processNext()).stage).toBe("assemble_report");
    await expect(analyses.loadReport(pipeline.publicId)).resolves.toMatchObject({ status: "complete" });
  });

  it("finishes after an optional enrichment job exhausts its retries", async () => {
    const pipeline = await createWorkerPipeline({ workerNow: new Date() });
    for (let index = 0; index < 5; index += 1) await pipeline.processNext();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await jobs.leaseForAnalysis("exhausted-enrich-worker", 60, pipeline.initial.id);
      expect(job?.stage).toBe("enrich");
      if (!job) throw new Error("Missing enrich job");
      await processJob(job, {
        workerId: "exhausted-enrich-worker", jobs,
        stages: { ...pipeline.stages, enrich: async () => { throw Object.assign(new Error("enrichment offline"), { transient: true }); } },
      });
      expect((await client.from("analysis_jobs").update({ available_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", job.id)).error).toBeNull();
    }
    const { data: failedRun } = await client.from("analysis_runs").select("stage_states")
      .eq("id", pipeline.initial.current_run_id).single();
    expect(failedRun?.stage_states?.enrich).toMatchObject({ status: "unavailable" });
    expect((await pipeline.processNext()).stage).toBe("assemble_report");
    await expect(analyses.loadReport(pipeline.publicId)).resolves.toMatchObject({ status: "complete" });
  });

  it("does not display committed artifacts whose producer did not publish terminal state", async () => {
    const pipeline = await createWorkerPipeline();
    const { id: analysisId, current_run_id: runId } = pipeline.initial;
    const source = await client.from("source_snapshots").insert({
      analysis_id: analysisId, run_id: runId, source_type: "auto24",
      extraction_status: "complete", producer_stage: "capture_listing",
    }).select("id").single();
    expect(source.error).toBeNull();
    const fact = await client.from("vehicle_facts").insert({
      analysis_id: analysisId, run_id: runId, source_snapshot_id: source.data!.id,
      fact_key: "vin", fact_value: "UNPUBLISHED", verification: "unverified",
      match_confidence: 0.9, producer_stage: "normalize_identity",
    });
    expect(fact.error).toBeNull();
    const evidence = await client.from("evidence").insert({
      analysis_id: analysisId, run_id: runId, source_snapshot_id: source.data!.id,
      source_class: "seller", claim: "Unpublished claim", applicability: "exact vehicle",
      confidence: 0.8, producer_stage: "baseline_checks",
    });
    expect(evidence.error).toBeNull();
    const report = await analyses.loadReport(pipeline.publicId);
    expect(report?.vehicleFacts).toEqual([]);
    expect(report?.evidence).toEqual([]);
    expect(report?.sources).toEqual({});
  });

  it("leases older work before a newer initial partial assembly", async () => {
    const older = await createWorkerPipeline();
    const newer = await createWorkerPipeline();
    const done = { version: 1, status: "complete", output: {}, warnings: [], completedAt: capturedAt };
    for (const pipeline of [older, newer]) {
      const runId = pipeline.initial.current_run_id;
      const { error } = await client.from("analysis_runs").update({
        stage_states: { capture_listing: done, normalize_identity: done, baseline_checks: done },
      }).eq("id", runId);
      expect(error).toBeNull();
      expect((await client.from("analysis_jobs").update({ status: "complete" })
        .eq("run_id", runId).eq("stage", "capture_listing")).error).toBeNull();
    }
    await jobs.enqueue({ analysisId: older.initial.id, runId: older.initial.current_run_id, stage: "research" });
    await jobs.enqueue({ analysisId: newer.initial.id, runId: newer.initial.current_run_id, stage: "assemble_report" });
    // Keep the older fixture ahead of jobs that another local process may enqueue after the guard.
    expect((await client.from("analysis_runs").update({ created_at: "0001-01-01T00:00:00+00:00" })
      .eq("id", older.initial.current_run_id)).error).toBeNull();
    await expectNoForeignQueuedJobs([older.initial.id, newer.initial.id]);
    const first = await jobs.lease("fairness-worker", 60);
    expect(first?.analysisId).toBe(older.initial.id);
    expect(first?.stage).toBe("research");
  });
});
