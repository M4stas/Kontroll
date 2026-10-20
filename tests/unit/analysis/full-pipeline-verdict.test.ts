import { describe, expect, it, vi } from "vitest";
import { runStage, type StageContext } from "@/analysis/pipeline";
import type { AnalysisRunContext } from "@/server/repositories/analyses";
import type { ListingSnapshot } from "@/listings/adapter";
import type { AnalysisStage } from "@/analysis/stages";
import type { ReviewExecutionsRepository, ReviewRunSnapshot } from "@/server/repositories/review-executions";

const capturedAt = "2026-09-25T09:00:00.000Z";

function listing(facts: Array<[string, string]>): ListingSnapshot {
  return {
    type: "snapshot", marketplace: "auto24", sourceId: "raw-listing",
    sourceUrl: "https://www.auto24.ee/soidukid/123456", capturedAt,
    contentHash: "fixture-content", description: "", imageUrls: [], screenshotRefs: [], claims: [], warnings: [],
    facts: facts.map(([key, value], index) => ({ key, value, sourceId: `raw-${index}`, verification: "unverified", confidence: 0.5 })),
  };
}

async function executePipeline(snapshot: ListingSnapshot, locale: "en" | "et" = "en") {
  const run: AnalysisRunContext = {
    analysisId: "analysis-1", publicId: "public-1", runId: "run-1", locale,
    input: { listingUrl: snapshot.sourceUrl, inputType: "url" }, supplements: [], stageStates: {},
  };
  const published: Array<{ verdict: string | null; confidence: string | null }> = [];
  const savedEvidence: Array<{ sourceClass: string; verification: string; claim: string }> = [];
  const savedSources: Array<{ sourceType: string; sourceUrl?: string }> = [];
  const savedFindings: Array<{ category: string; title: string; evidenceLinks: Array<{ evidenceId: string }> }> = [];
  const savedActions: Array<{ instructions: string }> = [];
  let pinned: ReviewRunSnapshot | null = null;
  const context: StageContext = {
    analysisId: run.analysisId, runId: run.runId, stage: "capture_listing",
    analyses: {
      loadRunContext: async () => run,
      saveStageResult: async (input) => { run.stageStates = { ...input.stageStates, [input.stage]: input.result }; },
      finalizeAssembly: async (input) => {
        run.stageStates = { ...run.stageStates, assemble_report: input.result };
        published.push({ verdict: input.verdict, confidence: input.confidence });
      },
    },
    evidence: {
      createSourceSnapshot: async (input) => ({ id: input.id! }),
      saveSourceSnapshots: async (inputs) => { savedSources.push(...inputs); return inputs.map((input) => input.id!); },
      saveVehicleFacts: async () => {}, saveEvidence: async (inputs) => { savedEvidence.push(...inputs); return inputs.map((item) => item.id!); },
      saveFindings: async (inputs) => { savedFindings.push(...inputs); return inputs.map((item) => item.id!); },
      saveActions: async (inputs) => { savedActions.push(...inputs); return inputs.map((item) => item.id!); },
    },
    listingAdapter: { canHandle: () => true, capture: vi.fn().mockResolvedValue(snapshot) },
    // Durable review with review disabled: enrich pins a disabled snapshot and records its progress.
    jobId: "enrich-job", workerId: "worker",
    insightEnvironment: { DATA_REVIEW_ENABLED: "false" },
    reviewExecutions: ({
      loadSnapshot: async () => pinned,
      pinRunSnapshot: async (_lease, draft) => (pinned = { ...draft, id: "snapshot-1" } as unknown as ReviewRunSnapshot),
      loadExecutions: async () => [],
      saveProgress: async (_lease, result) => { run.stageStates = { ...run.stageStates, enrich: result }; },
    } satisfies Pick<ReviewExecutionsRepository, "loadSnapshot" | "pinRunSnapshot" | "loadExecutions" | "saveProgress">
      ) as unknown as ReviewExecutionsRepository,
    now: () => new Date(capturedAt),
  };
  for (const stage of ["capture_listing", "normalize_identity", "baseline_checks", "assemble_report", "research", "enrich", "assemble_report"] as AnalysisStage[]) {
    context.stage = stage;
    await runStage(context);
  }
  return { run, final: published.at(-1), savedEvidence, savedSources, savedFindings, savedActions };
}

describe("real pipeline verdict reachability", () => {
  it("publishes Estonian deterministic analysis and seller instructions", async () => {
    const source = listing([["make", "Toyota"], ["model", "Corolla"]]);
    source.description = "Suurhooldus tehtud.";
    source.claims = [{ text: source.description, sourceClass: "seller", verification: "unverified" }];
    const result = await executePipeline(source, "et");
    expect(result.savedFindings).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Suure hoolduse väide vajab tõendit" })]));
    expect(result.savedActions).toEqual(expect.arrayContaining([expect.objectContaining({ instructions: "Palu müüjal saata arved või hooldusdokumendid, kus tehtud tööd on kirjas." })]));
  });
  it("recommends likely skip for two confirmed inconsistencies in listing identity and mileage", async () => {
    const result = await executePipeline(listing([
      ["make", "Volkswagen"], ["model", "Passat"],
      ["vin", "WVWMR7AN4DE000001"], ["vin", "WVWMR7AN4DE000002"],
      ["mileage", "210 000 km"], ["mileage", "232 000 km"],
    ]));
    expect(result.final?.verdict).toBe("likely_skip");
    expect(result.final?.confidence).toBe("low");
  });
});
