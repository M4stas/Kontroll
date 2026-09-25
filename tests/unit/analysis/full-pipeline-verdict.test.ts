import { describe, expect, it, vi } from "vitest";
import { runStage, type StageContext } from "@/analysis/pipeline";
import type { AnalysisRunContext } from "@/server/repositories/analyses";
import type { ListingSnapshot } from "@/listings/adapter";
import type { AnalysisStage } from "@/analysis/stages";
import type { ResearchProvider } from "@/research/provider";
import type { InsightProvider } from "@/insights/provider";
import { LunaInsightProvider } from "@/insights/luna";

const capturedAt = "2026-09-25T09:00:00.000Z";

function listing(facts: Array<[string, string]>): ListingSnapshot {
  return {
    type: "snapshot", marketplace: "auto24", sourceId: "raw-listing",
    sourceUrl: "https://www.auto24.ee/soidukid/123456", capturedAt,
    contentHash: "fixture-content", description: "", imageUrls: [], screenshotRefs: [], claims: [], warnings: [],
    facts: facts.map(([key, value], index) => ({ key, value, sourceId: `raw-${index}`, verification: "unverified", confidence: 0.5 })),
  };
}

async function executePipeline(snapshot: ListingSnapshot, researchProvider?: ResearchProvider, insightProvider?: InsightProvider, locale: "en" | "et" = "en") {
  const run: AnalysisRunContext = {
    analysisId: "analysis-1", publicId: "public-1", runId: "run-1", locale,
    input: { listingUrl: snapshot.sourceUrl, inputType: "url" }, supplements: [], stageStates: {},
  };
  const published: Array<{ verdict: string | null; confidence: string | null }> = [];
  const savedEvidence: Array<{ sourceClass: string; verification: string; claim: string }> = [];
  const savedSources: Array<{ sourceType: string; sourceUrl?: string }> = [];
  const savedFindings: Array<{ category: string; title: string; evidenceLinks: Array<{ evidenceId: string }> }> = [];
  const savedActions: Array<{ instructions: string }> = [];
  const context: StageContext = {
    analysisId: run.analysisId, runId: run.runId, stage: "capture_listing",
    analyses: {
      loadRunContext: async () => run,
      saveStageResult: async (input) => { run.stageStates = { ...input.stageStates, [input.stage]: input.result }; },
      publishRun: async (input) => { published.push({ verdict: input.verdict, confidence: input.confidence }); },
    },
    evidence: {
      createSourceSnapshot: async (input) => ({ id: input.id! }),
      saveSourceSnapshots: async (inputs) => { savedSources.push(...inputs); return inputs.map((input) => input.id!); },
      saveVehicleFacts: async () => {}, saveEvidence: async (inputs) => { savedEvidence.push(...inputs); return inputs.map((item) => item.id!); },
      saveFindings: async (inputs) => { savedFindings.push(...inputs); return inputs.map((item) => item.id!); },
      saveActions: async (inputs) => { savedActions.push(...inputs); return inputs.map((item) => item.id!); },
    },
    listingAdapter: { canHandle: () => true, capture: vi.fn().mockResolvedValue(snapshot) },
    researchProvider,
    insightProvider,
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
    const result = await executePipeline(source, undefined, undefined, "et");
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

  it("reaches moderate confidence but remains cautious when image categories are incomplete", async () => {
    const snapshot = listing([["make", "Toyota"], ["model", "Corolla"], ["year", "2018"], ["vin", "JTDBR32E720000001"]]);
    const provider: ResearchProvider = { research: async () => ({
      summary: "VIN decode only", identity: { vin: "JTDBR32E720000001", make: "Toyota", model: "Corolla", year: 2018 },
      sourceRefs: [{ url: "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/JTDBR32E720000001?format=json", sourceClass: "official_registry", applicability: "exact", retrievedAt: capturedAt }],
    }) };
    const result = await executePipeline(snapshot, provider);
    expect(result.final).toMatchObject({ verdict: "proceed_cautiously", confidence: "moderate" });
    expect(result.savedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ sourceClass: "official_registry", verification: "official", claim: expect.stringContaining("VIN") })]));
  });

  it("labels NHTSA evidence in Estonian as VIN identity only", async () => {
    const source = listing([["make", "Toyota"], ["model", "Corolla"], ["year", "2018"], ["vin", "JTDBR32E720000001"]]);
    const provider: ResearchProvider = { research: async () => ({
      summary: "VIN identity only", identity: { vin: "JTDBR32E720000001", make: "Toyota", model: "Corolla", year: 2018 },
      sourceRefs: [{ url: "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/JTDBR32E720000001?format=json", sourceClass: "official_registry", applicability: "exact", retrievedAt: capturedAt }],
    }) };
    const result = await executePipeline(source, provider, undefined, "et");
    expect(result.savedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({
      claim: expect.stringContaining("NHTSA VINi dekodeerimine"),
    })]));
    expect(result.final?.verdict).toBe("proceed_cautiously");
  });

  it("reaches worth viewing but keeps moderate confidence for seller-labeled images and VIN identity alone", async () => {
    const snapshot = listing([["make", "Toyota"], ["model", "Corolla"], ["year", "2018"], ["vin", "JTDBR32E720000001"]]);
    snapshot.inspectionImages = ["underside", "engine_bay", "instrument_cluster", "service_document"].map((category, index) => ({ url: `https://images.auto24.ee/${index}.jpg`, category: category as "underside" }));
    snapshot.imageUrls = snapshot.inspectionImages.map((item) => item.url);
    const provider: ResearchProvider = { research: async () => ({
      summary: "VIN decode only", identity: { vin: "JTDBR32E720000001", make: "Toyota", model: "Corolla", year: 2018 },
      sourceRefs: [{ url: "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/JTDBR32E720000001?format=json", sourceClass: "official_registry", applicability: "exact", retrievedAt: capturedAt }],
    }) };
    const result = await executePipeline(snapshot, provider);
    expect(result.final).toMatchObject({ verdict: "worth_viewing", confidence: "moderate" });
  });

  it("retains a Luna-style important finding whose registered source ID is cited", async () => {
    const source = { id: "luna-source-1", url: "https://example.org/research", title: "Independent context", sourceClass: "independent" as const, applicability: "model" as const, confidence: 0.6, observation: "Model-level context only" };
    const client = { responses: { create: vi.fn().mockResolvedValue({ output_text: JSON.stringify({
      schemaVersion: 1, sources: [source], warnings: [], imageObservations: [],
      findings: [{ id: "luna-finding-1", category: "model_context", severity: "important", title: "Check model issue", observation: "Unverified model issue", source, evidenceIds: [source.id], recommendedAction: { kind: "inspection_task", title: "Inspect issue", instructions: "Ask a workshop to check." } }],
    }) }) } };
    const insightProvider = new LunaInsightProvider(client as never, "configured-luna-model");
    const result = await executePipeline(listing([["make", "Toyota"], ["model", "Corolla"]]), undefined, insightProvider);
    expect(result.savedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ sourceClass: "independent", verification: "unverified" })]));
    expect(result.savedSources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceType: "insightResearch", sourceUrl: "https://example.org/research" })]));
    expect(result.savedFindings).toEqual(expect.arrayContaining([expect.objectContaining({ category: "model_context", evidenceLinks: [expect.objectContaining({ evidenceId: expect.any(String) })] })]));
  });
});
