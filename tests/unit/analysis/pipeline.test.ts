import { describe, expect, it, vi } from "vitest";
import { runStage, type StageContext } from "@/analysis/pipeline";
import type { AnalysisRunContext, VersionedStageResult } from "@/server/repositories/analyses";
import type { Action, Evidence, Finding } from "@/domain/analysis";
import type { ListingSnapshot } from "@/listings/adapter";

const completedAt = "2026-09-18T12:00:00.000Z";

const evidence: Evidence = {
  id: "evidence-1",
  sourceId: "listing-source",
  sourceClass: "listing",
  sourceUrl: "https://www.auto24.ee/soidukid/123456",
  claim: "Seller claims regular servicing.",
  applicability: "Requires independent verification.",
  confidence: 0.5,
  verification: "unverified",
  capturedAt: completedAt,
};

const unsupportedFinding: Finding = {
  id: "unsupported-finding",
  category: "condition",
  severity: "important",
  state: "open",
  title: "Unsupported insight",
  explanation: "No supplied evidence supports this observation.",
  nextAction: "Inspect the reported condition.",
  evidenceIds: ["missing-evidence"],
  origin: "agent",
};

const unsupportedAction: Action = {
  id: "unsupported-action",
  kind: "inspection_task",
  title: "Inspect unsupported condition",
  instructions: "Verify the condition during inspection.",
  status: "open",
  findingId: unsupportedFinding.id,
};

function stageResult<T>(status: "complete" | "unavailable", output: T): VersionedStageResult<T> {
  return { version: 1, status, output, warnings: status === "unavailable" ? ["enrich_unavailable"] : [], completedAt };
}

function assemblyContext(enrich: VersionedStageResult<{ findings: Finding[]; actions: Action[] }>) {
  const snapshot: ListingSnapshot = {
    type: "snapshot",
    marketplace: "auto24",
    sourceId: "listing-source",
    sourceUrl: "https://www.auto24.ee/soidukid/123456",
    capturedAt: completedAt,
    contentHash: "listing-content-hash",
    description: "Regularly serviced according to the seller.",
    imageUrls: [],
    screenshotRefs: [],
    facts: [{ key: "make", value: "Toyota", sourceId: "listing-source", verification: "unverified", confidence: 0.5 }],
    claims: [],
    warnings: [],
  };
  const run: AnalysisRunContext = {
    analysisId: "analysis-1",
    publicId: "public-1",
    runId: "run-1",
    locale: "en",
    input: { listingUrl: snapshot.sourceUrl, inputType: "url" },
    stageStates: {
      capture_listing: stageResult("complete", { snapshot }),
      normalize_identity: stageResult("complete", {
        vehicle: {
          make: "Toyota",
          provenance: {
            make: ["listing-source"], model: [], year: [], mileageKm: [], fuel: [], transmission: [],
            vin: [], registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [],
          },
          conflicts: [],
        },
      }),
      baseline_checks: stageResult("complete", { evidence: [evidence], findings: [], actions: [] }),
      research: stageResult("complete", { sourceStates: {} }),
      enrich,
      assemble_report: stageResult("complete", { status: "partial", advanceToResearch: true }),
    },
  };
  const savedFindings: Array<{ id?: string }> = [];
  const savedActions: Array<{ id?: string }> = [];
  const published = vi.fn().mockResolvedValue(undefined);
  const context: StageContext = {
    analysisId: run.analysisId,
    runId: run.runId,
    stage: "assemble_report",
    analyses: {
      loadRunContext: async () => run,
      saveStageResult: async (input) => { run.stageStates = { ...input.stageStates, [input.stage]: input.result }; },
      publishRun: published,
    },
    evidence: {
      createSourceSnapshot: vi.fn(),
      saveVehicleFacts: vi.fn(),
      saveEvidence: vi.fn(),
      saveFindings: async (inputs) => {
        savedFindings.push(...inputs);
        return inputs.map((input) => input.id ?? "generated-finding");
      },
      saveActions: async (inputs) => {
        savedActions.push(...inputs);
        return inputs.map((input) => input.id ?? "generated-action");
      },
    },
    listingAdapter: { canHandle: () => true, capture: vi.fn() },
    now: () => new Date(completedAt),
  };
  return { context, published, savedActions, savedFindings };
}

describe("pipeline assembly", () => {
  // Catches raw optional findings bypassing the report's evidence filter during final persistence.
  it("persists only evidence-filtered enrichment records on final reassembly", async () => {
    const test = assemblyContext(stageResult("complete", {
      findings: [unsupportedFinding],
      actions: [unsupportedAction],
    }));

    await runStage(test.context);

    expect(test.savedFindings).toEqual([]);
    expect(test.savedActions).toEqual([]);
  });

  // Catches a terminal unavailable optional stage keeping a usable deterministic report partial forever.
  it("completes deterministic assembly when enrichment is unavailable", async () => {
    const test = assemblyContext(stageResult("unavailable", { findings: [], actions: [] }));

    const result = await runStage(test.context);

    expect(result).toMatchObject({ status: "complete", output: { status: "complete", advanceToResearch: false } });
    expect(test.published).toHaveBeenCalledWith(expect.objectContaining({ status: "complete" }));
  });
});
