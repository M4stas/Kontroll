import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createSubmissionHandler } from "@/app/api/analyses/[publicId]/submissions/handler";

const publicId = "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1";

describe("buyer listing fallback submission", () => {
  it("accepts pasted listing text and screenshots with buyer provenance", async () => {
    const addSubmission = vi.fn().mockResolvedValue({ runId: "run-2", queuedStages: ["capture_listing"], created: true });
    const upload = vi.fn().mockResolvedValue({ storageKey: "analysis-1/shot.png", mimeType: "image/png", size: 5 });
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue("analysis-1"),
      uploads: { upload, remove: vi.fn() },
      addSubmission,
      reconcileSubmission: vi.fn(),
    });
    const form = new FormData();
    form.set("idempotencyKey", "b59ed9b9-e21e-4624-87bc-fbe327787d7d");
    form.set("listingText", "Mark: Volvo\nMudel: V60");
    form.append("listingScreenshots", new File([new Uint8Array([1, 2, 3])], "listing.png", { type: "image/png" }));
    const request = new NextRequest(`https://example.test/api/analyses/${publicId}/submissions`, {
      method: "POST", headers: { "content-length": "1000" },
    });
    vi.spyOn(request, "formData").mockResolvedValue(form);
    const response = await handler(request, { params: Promise.resolve({ publicId }) });
    expect(response.status).toBe(202);
    expect(addSubmission).toHaveBeenCalledWith(expect.objectContaining({ items: [
      expect.objectContaining({ kind: "buyer_note", providedBy: "buyer", textContent: "Mark: Volvo\nMudel: V60" }),
      expect.objectContaining({ kind: "screenshot", providedBy: "buyer", storageKey: "analysis-1/shot.png" }),
    ] }));
  });
});
