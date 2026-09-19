import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStageHandlers } from "@/analysis/pipeline";
import type { InsightProvider } from "@/insights/provider";
import type { ListingAdapter, ListingSnapshot } from "@/listings/adapter";
import type { ResearchProvider } from "@/research/provider";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";
import { JobsRepository } from "@/server/repositories/jobs";
import { processJob } from "@/worker/process-job";

function localServiceClient(): SupabaseClient {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const key = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  if (!values.API_URL || !key) throw new Error("Local Supabase service credentials are unavailable");
  return createClient(values.API_URL, key, { auth: { autoRefreshToken: false, persistSession: false } });
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

  beforeAll(() => {
    client = localServiceClient();
    analyses = new AnalysesRepository(client);
    evidence = new EvidenceRepository(client);
    jobs = new JobsRepository(client);
  });

  beforeEach(async () => {
    const { error } = await client.from("analyses").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    expect(error).toBeNull();
  });

  async function createWorkerPipeline(input: {
    insightProvider?: InsightProvider;
    workerNow?: Date;
  } = {}) {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
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
      const leased = await jobs.lease("progressive-worker", 60);
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
    return { publicId, initial, processNext };
  }

  async function processThroughFinal(processNext: (failCompletion?: boolean) => Promise<{ stage: string }>) {
    for (let index = 0; index < 7; index += 1) await processNext();
  }

  // Catches the worker graph skipping the readable baseline and warning-only enrichment blocking completion.
  it("publishes through the worker, then completes with warning-only enrichment and policy confidence", async () => {
    const { publicId } = await analyses.create({
      accessTokenHash: createAccessToken().hash,
      locale: "en",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
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
      const leased = await jobs.lease("progressive-worker", 60);
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

  // Catches a retried enrich completion reopening an already-final assembly job and reinserting stable insight records.
  it("does not reopen final assembly when enrichment retries after its completion write fails", async () => {
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
    const finalAssembly = await pipeline.processNext();
    expect(finalAssembly.stage).toBe("assemble_report");
    const { error: makeRetryAvailable } = await client
      .from("analysis_jobs")
      .update({ available_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", retriedEnrich.id);
    expect(makeRetryAvailable).toBeNull();
    const retriedCompletion = await pipeline.processNext();
    expect(retriedCompletion.stage).toBe("enrich");

    await expect(jobs.lease("verification-worker", 60)).resolves.toBeNull();
    const [{ data: findings }, { data: actions }] = await Promise.all([
      client.from("findings").select("title").eq("analysis_id", pipeline.initial.id).eq("title", "Supported insight"),
      client.from("actions").select("title").eq("analysis_id", pipeline.initial.id).eq("title", "Inspect supported condition"),
    ]);
    expect(findings).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });
});
