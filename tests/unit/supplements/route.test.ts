import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createSubmissionHandler } from "@/app/api/analyses/[publicId]/submissions/route";

const PUBLIC_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "11111111-1111-4111-8111-111111111111";

function context() {
  return { params: Promise.resolve({ publicId: PUBLIC_ID }) };
}

function requestWithForm(form: FormData) {
  return {
    cookies: { get: vi.fn().mockReturnValue({ value: "private-cookie" }) },
    formData: vi.fn().mockResolvedValue(form),
  } as never;
}

describe("POST /api/analyses/[publicId]/submissions", () => {
  it("verifies access before reading multipart files or loading the analysis", async () => {
    const request = new NextRequest(`http://localhost/api/analyses/${PUBLIC_ID}/submissions`, {
      method: "POST",
      body: new FormData(),
    });
    const formData = vi.spyOn(request, "formData");
    const loadAnalysisId = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(false),
      loadAnalysisId,
      uploads: {} as never,
      addSubmission: vi.fn(),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(401);
    expect(formData).not.toHaveBeenCalled();
    expect(loadAnalysisId).not.toHaveBeenCalled();
  });

  it("returns processing state without exposing storage keys or signed URLs", async () => {
    const body = new FormData();
    body.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
    body.set("sellerAnswer", "The timing belt was changed in 2024.");
    body.append("files", new File([new Uint8Array([1, 2, 3])], "service.jpg", { type: "image/jpeg" }));
    const request = requestWithForm(body);
    const remove = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {
        upload: vi.fn().mockResolvedValue({
          storageKey: `${ANALYSIS_ID}/private-photo.jpg`,
          mimeType: "image/jpeg",
          size: 3,
        }),
        remove,
      } as never,
      addSubmission: vi.fn().mockResolvedValue({
        runId: "44444444-4444-4444-8444-444444444444",
        queuedStages: ["baseline_checks", "enrich", "assemble_report"],
        created: true,
      }),
    });

    const response = await handler(request, context());
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      runId: "44444444-4444-4444-8444-444444444444",
      queuedStages: ["baseline_checks", "enrich", "assemble_report"],
      files: [{ type: "image/jpeg", state: "processing" }],
    });
    expect(JSON.stringify(payload)).not.toContain(ANALYSIS_ID);
    expect(JSON.stringify(payload)).not.toContain("http");
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes newly uploaded private objects when database persistence fails", async () => {
    const body = new FormData();
    body.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
    body.append("files", new File([new Uint8Array([1, 2, 3])], "service.pdf", { type: "application/pdf" }));
    const request = requestWithForm(body);
    const storageKey = `${ANALYSIS_ID}/private-document.pdf`;
    const remove = vi.fn().mockResolvedValue(undefined);
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {
        upload: vi.fn().mockResolvedValue({ storageKey, mimeType: "application/pdf", size: 3 }),
        remove,
      } as never,
      addSubmission: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(500);
    expect(remove).toHaveBeenCalledWith(ANALYSIS_ID, [storageKey]);
  });
});
