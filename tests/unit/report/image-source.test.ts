import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createImageHandler } from "@/app/api/analyses/[publicId]/images/[evidenceId]/handler";
import { reviewImageSources } from "@/features/report/image-sources";
const publicId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const context = {params: Promise.resolve({publicId, evidenceId})};
const request = () => new NextRequest(`https://kontroll.test/api/analyses/${publicId}/images/${evidenceId}`);
it("denies photo access before looking up private storage", async () => {
 const loadImage = vi.fn();
 const response = await createImageHandler({verifyAccess: async()=>false, loadImage})(request(), context);
 expect(response.status).toBe(401); expect(loadImage).not.toHaveBeenCalled();
});
it("serves the cited image privately without exposing storage URLs", async () => {
 const bytes = new Uint8Array([1,2,3]);
 const response = await createImageHandler({verifyAccess: async()=>true, loadImage: async()=>({bytes,mimeType:"image/jpeg"})})(request(), context);
 expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/jpeg");
 expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(response.headers.get("x-content-type-options")).toBe("nosniff");
 expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});
it("returns not found for unavailable or foreign images", async () => {
 const response = await createImageHandler({verifyAccess:async()=>true,loadImage:async()=>null})(request(),context);
 expect(response.status).toBe(404);
});
it("maps immutable evidence IDs to their owned image only", () => {
 const image = {evidenceId,storageKey:`${publicId}/photo.jpg`,status:"accepted",mimeType:"image/jpeg"};
 const rows = [{analysis_id:publicId,snapshot:{analysisId:publicId,imageManifest:{images:[image,{...image,evidenceId:"33333333-3333-4333-8333-333333333333",storageKey:"other/photo.jpg"},{evidenceId:"44444444-4444-4444-8444-444444444444",status:"skipped"}]}}}, {analysis_id:"other",snapshot:{analysisId:"other",imageManifest:{images:[{...image,evidenceId:"55555555-5555-4555-8555-555555555555"}]}}}];
 const sources=reviewImageSources(publicId,rows);
 expect(sources.get(evidenceId)?.storageKey).toBe(`${publicId}/photo.jpg`);
 expect(sources.has("33333333-3333-4333-8333-333333333333")).toBe(false); expect(sources.has("55555555-5555-4555-8555-555555555555")).toBe(false);
 expect(sources.get("44444444-4444-4444-8444-444444444444")).toEqual({});
});
