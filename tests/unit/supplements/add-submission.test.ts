import { describe, expect, it, vi } from "vitest";
import { addSubmission } from "@/features/supplements/add-submission";

describe("addSubmission", () => {
  it("returns prerequisite stages added atomically by persistence", async () => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({
      runId: "run-1",
      queuedStages: ["capture_listing", "normalize_identity", "baseline_checks", "enrich", "assemble_report"],
      created: true,
    }) };

    const result = await addSubmission(
      { kind: "image", analysisId: "analysis-1", storageKey: "private/photo.webp" } as never,
      { jobs } as never,
    );

    expect(result.queuedStages).toEqual([
      "capture_listing", "normalize_identity", "baseline_checks", "enrich", "assemble_report",
    ]);
  });

  it("queues image enrichment and assembly without recapturing the listing", async () => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({ runId: "run-1", queuedStages: ["enrich", "assemble_report"], created: true }) };
    const result = await addSubmission({ kind: "image", analysisId: "analysis-1", storageKey: "private/photo.webp" } as never, { jobs } as never);
    expect(result.queuedStages).toEqual(["enrich", "assemble_report"]);
    expect(result.queuedStages).not.toContain("capture_listing");
  });

  it.each([
    ["seller_answer", ["baseline_checks", "enrich", "assemble_report"]],
    ["screenshot", ["enrich", "assemble_report"]],
    ["document", ["baseline_checks", "enrich", "assemble_report"]],
  ] as const)("queues only affected stages for %s", async (kind, expected) => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({ runId: "run-1", queuedStages: expected, created: true }) };

    const result = await addSubmission({
      analysisId: "analysis-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      kind,
      ...(kind === "seller_answer" ? { textContent: "Timing belt changed." } : { storageKey: "private/item" }),
    } as never, { jobs } as never);

    expect(result.queuedStages).toEqual(expected);
  });

  it("queues identity-dependent stages for a VIN correction", async () => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({
      runId: "run-1",
      queuedStages: ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"],
      created: true,
    }) };

    const result = await addSubmission({
      analysisId: "analysis-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      kind: "seller_answer",
      textContent: "Correct VIN: WBA12345678901234",
      identityCorrection: "vin",
    } as never, { jobs } as never);

    expect(result.queuedStages).toEqual([
      "normalize_identity",
      "baseline_checks",
      "research",
      "enrich",
      "assemble_report",
    ]);
  });

  it("rejects seller answer text over 10,000 characters before persistence", async () => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({ runId: "run-1", queuedStages: [], created: true }) };

    await expect(addSubmission({
      analysisId: "analysis-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      kind: "seller_answer",
      textContent: "x".repeat(10_001),
    } as never, { jobs } as never)).rejects.toThrow("10,000");
    expect(jobs.enqueueMany).not.toHaveBeenCalled();
  });

  it("rejects more than eight files before persistence", async () => {
    const jobs = { enqueueMany: vi.fn().mockResolvedValue({ runId: "run-1", queuedStages: [], created: true }) };

    await expect(addSubmission({
      analysisId: "analysis-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      items: Array.from({ length: 9 }, (_, index) => ({
        kind: "image",
        storageKey: `analysis/file-${index}.webp`,
        mimeType: "image/webp",
      })),
    } as never, { jobs } as never)).rejects.toThrow("eight files");
    expect(jobs.enqueueMany).not.toHaveBeenCalled();
  });
});
