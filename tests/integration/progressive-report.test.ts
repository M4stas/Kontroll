import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runStage } from "@/analysis/pipeline";
import type { AnalysisStage } from "@/analysis/stages";
import type { InsightProvider } from "@/insights/provider";
import type { ListingAdapter, ListingSnapshot } from "@/listings/adapter";
import type { ResearchProvider } from "@/research/provider";
import { createAccessToken } from "@/server/access/tokens";
import { AnalysesRepository } from "@/server/repositories/analyses";
import { EvidenceRepository } from "@/server/repositories/evidence";

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

  beforeAll(() => {
    client = localServiceClient();
    analyses = new AnalysesRepository(client);
    evidence = new EvidenceRepository(client);
  });

  beforeEach(async () => {
    const { error } = await client.from("analyses").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    expect(error).toBeNull();
  });

  // Catches a deterministic baseline being unreadable until optional research or Luna enrichment completes.
  it("publishes a partial baseline, then makes a later enriched run current", async () => {
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
      enrich: async () => ({ schemaVersion: 1, sources: [], findings: [], imageObservations: [], warnings: [] }),
    };
    const execute = async (runId: string, stages: AnalysisStage[]) => {
      for (const stage of stages) {
        await runStage({
          analysisId: initial.id,
          runId,
          stage,
          analyses,
          evidence,
          listingAdapter,
          researchProvider,
          insightProvider,
          now: () => new Date(capturedAt),
        });
      }
    };

    await execute(initial.current_run_id, ["capture_listing", "normalize_identity", "baseline_checks", "assemble_report"]);
    await expect(analyses.loadReport(publicId)).resolves.toMatchObject({
      status: "partial",
      findings: expect.any(Array),
      warnings: expect.arrayContaining(["research_pending", "enrich_pending"]),
    });

    const { data: enrichedRun, error: runError } = await client
      .from("analysis_runs")
      .insert({ analysis_id: initial.id, trigger: "supplement" })
      .select("id")
      .single();
    expect(runError).toBeNull();
    const { error: currentError } = await client
      .from("analyses")
      .update({ current_run_id: enrichedRun!.id, status: "queued", verdict: null, confidence: null })
      .eq("id", initial.id);
    expect(currentError).toBeNull();

    await execute(enrichedRun!.id, [
      "capture_listing",
      "normalize_identity",
      "baseline_checks",
      "research",
      "enrich",
      "assemble_report",
    ]);

    const report = await analyses.loadReport(publicId);
    expect(report).toMatchObject({ status: "complete" });
    const { data: states } = await client.from("analysis_runs").select("status, stage_states").eq("id", enrichedRun!.id).single();
    expect(states).toMatchObject({ status: "complete", stage_states: {
      baseline_checks: { version: 1, status: "complete" },
      enrich: { version: 1, status: "complete" },
    } });
  });
});
