import { PdfValidationError } from "@/server/storage/pdf-text";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { createSubmissionHandler } from "@/app/api/analyses/[publicId]/submissions/handler";

const PUBLIC_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "11111111-1111-4111-8111-111111111111";

function context() {
  return { params: Promise.resolve({ publicId: PUBLIC_ID }) };
}

function requestWithForm(form: FormData) {
  return {
    url: `http://localhost/api/analyses/${PUBLIC_ID}/submissions`,
    cookies: { get: vi.fn().mockReturnValue({ value: "private-cookie" }) },
    headers: new Headers({ "content-length": "1024", host: "localhost", origin: "http://localhost" }),
    formData: vi.fn().mockResolvedValue(form),
  } as never;
}

describe("POST /api/analyses/[publicId]/submissions", () => {
  it.each(["http://attacker.localhost", null])("denies foreign or absent origin %s before side effects", async (origin) => {
    const request = requestWithForm(new FormData()) as unknown as NextRequest;
    if (origin) request.headers.set("origin", origin);
    else request.headers.delete("origin");
    const verifyAccess = vi.fn().mockResolvedValue(true);
    const loadAnalysisId = vi.fn();
    const upload = vi.fn();
    const addSubmission = vi.fn();
    const response = await createSubmissionHandler({ verifyAccess, loadAnalysisId, uploads: { upload, remove: vi.fn() }, addSubmission, reconcileSubmission: vi.fn() })(request, context());
    expect(response.status).toBe(403);
    expect(verifyAccess).not.toHaveBeenCalled();
    expect(loadAnalysisId).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(addSubmission).not.toHaveBeenCalled();
  });

  it("verifies access before reading multipart files or loading the analysis", async () => {
    const request = new NextRequest(`http://localhost/api/analyses/${PUBLIC_ID}/submissions`, {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost" },
      body: new FormData(),
    });
    const formData = vi.spyOn(request, "formData");
    const loadAnalysisId = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(false),
      loadAnalysisId,
      uploads: {} as never,
      addSubmission: vi.fn(),
      reconcileSubmission: vi.fn(),
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
      reconcileSubmission: vi.fn(),
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

  it("preserves newly uploaded private objects after an ambiguous persistence attempt", async () => {
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
      reconcileSubmission: vi.fn().mockResolvedValue(null),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(500);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns the accepted group and preserves referenced objects after a committed response is lost", async () => {
    const body = new FormData();
    body.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
    body.append("files", new File([new Uint8Array([1, 2, 3])], "service.pdf", { type: "application/pdf" }));
    const request = requestWithForm(body);
    const storageKey = `${ANALYSIS_ID}/private-document.pdf`;
    const remove = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {
        upload: vi.fn().mockResolvedValue({ storageKey, mimeType: "application/pdf", size: 3 }),
        remove,
      } as never,
      addSubmission: vi.fn().mockRejectedValue(new Error("response lost after commit")),
      reconcileSubmission: vi.fn().mockResolvedValue({
        runId: "44444444-4444-4444-8444-444444444444",
        queuedStages: ["baseline_checks", "enrich", "assemble_report"],
        referencedStorageKeys: [storageKey],
      }),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      runId: "44444444-4444-4444-8444-444444444444",
      files: [{ type: "application/pdf", state: "processing" }],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("preserves uploads when reconciliation itself is indeterminate", async () => {
    const body = new FormData();
    body.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
    body.append("files", new File([new Uint8Array([1, 2, 3])], "service.pdf", { type: "application/pdf" }));
    const request = requestWithForm(body);
    const remove = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {
        upload: vi.fn().mockResolvedValue({
          storageKey: `${ANALYSIS_ID}/private-document.pdf`,
          mimeType: "application/pdf",
          size: 3,
        }),
        remove,
      } as never,
      addSubmission: vi.fn().mockRejectedValue(new Error("response lost")),
      reconcileSubmission: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(500);
    expect(remove).not.toHaveBeenCalled();
  });

  // Catches pre-persistence upload failures leaking objects that cannot be referenced by a committed group.
  it("removes completed uploads when a later upload fails before persistence starts", async () => {
    const body = new FormData();
    body.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
    body.append("files", new File([new Uint8Array([1])], "first.pdf", { type: "application/pdf" }));
    body.append("files", new File([new Uint8Array([2])], "second.pdf", { type: "application/pdf" }));
    const firstStorageKey = `${ANALYSIS_ID}/first.pdf`;
    const remove = vi.fn().mockResolvedValue(undefined);
    const addSubmission = vi.fn();
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {
        upload: vi.fn()
          .mockResolvedValueOnce({ storageKey: firstStorageKey, mimeType: "application/pdf", size: 1 })
          .mockRejectedValueOnce(new Error("storage unavailable")),
        remove,
      } as never,
      addSubmission,
      reconcileSubmission: vi.fn(),
    });

    const response = await handler(requestWithForm(body), context());

    expect(response.status).toBe(500);
    expect(addSubmission).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(ANALYSIS_ID, [firstStorageKey]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "unknown"],
    ["too large", String((8 * 12 * 1024 * 1024) + 1024 * 1024 + 1)],
  ])("rejects a %s content length before parsing multipart data", async (_label, contentLength) => {
    const formData = vi.fn();
    const request = {
      url: `http://localhost/api/analyses/${PUBLIC_ID}/submissions`,
      cookies: { get: vi.fn().mockReturnValue({ value: "private-cookie" }) },
      headers: new Headers({ host: "localhost", origin: "http://localhost", ...(contentLength ? { "content-length": contentLength } : {}) }),
      formData,
    } as never;
    const handler = createSubmissionHandler({
      verifyAccess: vi.fn().mockResolvedValue(true),
      loadAnalysisId: vi.fn().mockResolvedValue(ANALYSIS_ID),
      uploads: {} as never,
      addSubmission: vi.fn(),
      reconcileSubmission: vi.fn(),
    });

    const response = await handler(request, context());

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });
});

it.each(['model','provider','prompt','system','reasoning','DATA_REVIEW_MODEL','configuration'])('rejects multipart control %s before uploads or persistence',async field=>{
 const form=new FormData();form.set('idempotencyKey','33333333-3333-4333-8333-333333333333');form.set('sellerAnswer','Normal evidence');form.set(field,'evil');
 form.append('files',new File(['image'],'car.jpg',{type:'image/jpeg'}));
 const upload=vi.fn();const addSubmission=vi.fn();
 const handler=createSubmissionHandler({verifyAccess:vi.fn().mockResolvedValue(true),loadAnalysisId:vi.fn().mockResolvedValue(ANALYSIS_ID),uploads:{upload} as never,addSubmission,reconcileSubmission:vi.fn()});
 const response=await handler(requestWithForm(form),context());
 expect(response.status).toBe(400);expect(upload).not.toHaveBeenCalled();expect(addSubmission).not.toHaveBeenCalled();
});

it("persists extracted PDF text as document context", async () => {
  const form = new FormData();
  form.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
  form.append("files", new File(["pdf"], "report.pdf", { type: "application/pdf" }));
  const addSubmission = vi.fn().mockResolvedValue({runId:"run",queuedStages:["assemble_report"],created:true});
  const handler = createSubmissionHandler({verifyAccess:async()=>true,loadAnalysisId:async()=>ANALYSIS_ID,
    uploads:{upload:async()=>({storageKey:`${ANALYSIS_ID}/report.pdf`,mimeType:"application/pdf",size:3,textContent:"[Page 1]\nHistory"}),remove:vi.fn()},
    addSubmission,reconcileSubmission:vi.fn()});
  expect((await handler(requestWithForm(form),context())).status).toBe(202);
  expect(addSubmission.mock.calls[0]![0].items).toEqual([expect.objectContaining({kind:"document",textContent:"[Page 1]\nHistory"})]);
});
it("returns a clear PDF validation error before accepting a submission", async () => {
  const form = new FormData();
  form.set("idempotencyKey", "33333333-3333-4333-8333-333333333333");
  form.append("files", new File(["pdf"], "report.pdf", { type: "application/pdf" }));
  const addSubmission = vi.fn();
  const handler = createSubmissionHandler({verifyAccess:async()=>true,loadAnalysisId:async()=>ANALYSIS_ID,
    uploads:{upload:async()=>{throw new PdfValidationError("PDF has no readable text")},remove:vi.fn()},
    addSubmission,reconcileSubmission:vi.fn()});
  const response=await handler(requestWithForm(form),context());
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:"PDF has no readable text",code:"invalid_pdf"});
  expect(addSubmission).not.toHaveBeenCalled();
});
