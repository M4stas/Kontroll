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
    supplements: [],
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

function supplementStageContext(
  stage: StageContext["stage"],
  supplements: AnalysisRunContext["supplements"],
  insightProvider?: StageContext["insightProvider"],
) {
  const snapshot: ListingSnapshot = {
    type: "snapshot",
    marketplace: "auto24",
    sourceId: "listing-source",
    sourceUrl: "https://www.auto24.ee/soidukid/123456",
    capturedAt: completedAt,
    contentHash: "listing-content-hash",
    description: "Original listing",
    imageUrls: [],
    screenshotRefs: [],
    facts: [{ key: "make", value: "Toyota", sourceId: "listing-source", verification: "unverified", confidence: 0.5 }],
    claims: [],
    warnings: [],
  };
  const run: AnalysisRunContext = {
    analysisId: "analysis-1",
    publicId: "public-1",
    runId: "run-2",
    locale: "en",
    input: { listingUrl: snapshot.sourceUrl, inputType: "url" },
    supplements,
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
      baseline_checks: stageResult("complete", { evidence: [], findings: [], actions: [] }),
    },
  };
  if (stage === "normalize_identity") delete run.stageStates.normalize_identity;
  if (stage === "baseline_checks") delete run.stageStates.baseline_checks;
  const savedFacts: Array<{ key: string; value: string; verification: string }> = [];
  const savedEvidence: Evidence[] = [];
  const context: StageContext = {
    analysisId: run.analysisId,
    runId: run.runId,
    stage,
    analyses: {
      loadRunContext: async () => run,
      saveStageResult: async (input) => { run.stageStates = { ...input.stageStates, [input.stage]: input.result }; },
      publishRun: vi.fn(),
    },
    evidence: {
      createSourceSnapshot: vi.fn(),
      saveVehicleFacts: async (inputs) => { savedFacts.push(...inputs); },
      saveEvidence: async (inputs) => { savedEvidence.push(...inputs.map((item) => ({ ...item, id: item.id ?? "generated" }))); return []; },
      saveFindings: vi.fn().mockResolvedValue([]),
      saveActions: vi.fn().mockResolvedValue([]),
    },
    listingAdapter: { canHandle: () => true, capture: vi.fn() },
    insightProvider,
    now: () => new Date(completedAt),
  };
  return { context, run, savedEvidence, savedFacts };
}

describe("pipeline supplements", () => {
  it("scopes deterministic baseline records to each run so lineage reruns cannot collide", async () => {
    const first = supplementStageContext("baseline_checks", []);
    const second = supplementStageContext("baseline_checks", []);
    second.run.runId = "run-3";
    second.context.runId = "run-3";

    const firstResult = await runStage(first.context);
    const secondResult = await runStage(second.context);
    const firstIds = new Set((firstResult.output as { evidence: Evidence[] }).evidence.map((item) => item.id));
    const secondIds = (secondResult.output as { evidence: Evidence[] }).evidence.map((item) => item.id);

    expect(secondIds.every((id) => !firstIds.has(id))).toBe(true);
  });

  it.each([
    ["vin", "WVWZZZ1JZXW000001", "vin", "WVWZZZ1JZXW000001"],
    ["registrationPlate", "123ABC", "registrationPlate", "123 ABC"],
  ] as const)("applies the latest %s correction before normalization", async (identityCorrection, textContent, field, expected) => {
    const test = supplementStageContext("normalize_identity", [{
      id: "correction-1",
      kind: "seller_answer",
      providedBy: "seller",
      textContent,
      identityCorrection,
      sourceSnapshotId: "supplement-source-1",
    }]);

    const result = await runStage(test.context);

    expect((result.output as { vehicle: Record<string, unknown> }).vehicle[field]).toBe(expected);
    expect(test.savedFacts).toContainEqual(expect.objectContaining({
      key: identityCorrection === "vin" ? "vin" : "registration plate",
      value: textContent,
      verification: "unverified",
    }));
  });

  it.each([
    ["seller_answer", "seller", "The timing belt was changed.", undefined],
    ["buyer_note", "buyer", "I heard a cold-start rattle.", undefined],
    ["document", "seller", undefined, "application/pdf"],
    ["image", "seller", undefined, "image/jpeg"],
    ["screenshot", "buyer", undefined, "image/png"],
  ] as const)("turns %s material into explicit unverified evidence", async (kind, providedBy, textContent, mimeType) => {
    const test = supplementStageContext("baseline_checks", [{
      id: `${kind}-1`,
      kind,
      providedBy,
      ...(textContent ? { textContent } : {}),
      ...(mimeType ? { mimeType, storageKey: `analysis-1/${kind}` } : {}),
      sourceSnapshotId: `${kind}-source`,
    }]);

    const result = await runStage(test.context);
    const supplementEvidence = (result.output as { evidence: Evidence[] }).evidence.find(
      (item) => item.sourceId === `${kind}-source`,
    );

    expect(supplementEvidence).toMatchObject({
      sourceClass: providedBy,
      verification: "unverified",
      confidence: 0.5,
    });
    expect(test.savedEvidence).toContainEqual(expect.objectContaining({ id: supplementEvidence?.id }));
  });

  it("passes seller text, document context, screenshot context, and signed private images to enrichment", async () => {
    const enrich = vi.fn().mockResolvedValue({
      schemaVersion: 1, sources: [], findings: [], imageObservations: [], warnings: [],
    });
    const signedImage = {
      evidenceId: "29ee08ce-eb10-53d2-913f-230aac3128dc",
      analysisId: "analysis-1",
      storageKey: "analysis-1/image-1.jpg",
      signedUrl: "https://storage.example/private/image-1.jpg?signature=one",
      expiresAt: "2026-09-18T13:00:00.000Z",
    };
    const test = supplementStageContext("enrich", [
      { id: "answer-1", kind: "seller_answer", providedBy: "seller", textContent: "Belt changed.", sourceSnapshotId: "answer-source" },
      { id: "doc-1", kind: "document", providedBy: "seller", storageKey: "analysis-1/doc.pdf", mimeType: "application/pdf", sourceSnapshotId: "doc-source" },
      { id: "shot-1", kind: "screenshot", providedBy: "buyer", storageKey: "analysis-1/shot.png", mimeType: "image/png", sourceSnapshotId: "shot-source" },
      { id: "image-1", kind: "image", providedBy: "seller", storageKey: "analysis-1/image-1.jpg", mimeType: "image/jpeg", sourceSnapshotId: "image-source", signedImage },
    ], { enrich });
    test.run.stageStates.baseline_checks = stageResult("complete", {
      evidence: [
        { ...evidence, id: "29ee08ce-eb10-53d2-913f-230aac3128dc", sourceId: "image-source", sourceClass: "seller" },
      ],
      findings: [], actions: [],
    });

    await runStage(test.context);

    expect(enrich).toHaveBeenCalledWith(expect.objectContaining({
      sellerClaims: expect.arrayContaining(["Belt changed."]),
      documentText: expect.arrayContaining([expect.stringContaining("application/pdf")]),
      screenshotText: expect.arrayContaining([expect.stringContaining("image/png")]),
      images: [{ evidenceId: "29ee08ce-eb10-53d2-913f-230aac3128dc", capability: signedImage }],
    }));
  });
});
