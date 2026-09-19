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
});
