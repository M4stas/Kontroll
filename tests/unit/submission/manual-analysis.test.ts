import { describe, expect, it, vi } from "vitest";
import { createManualAnalysis } from "@/features/submission/manual-analysis";
describe("manual analysis", () => {
 it("creates a private report from buyer text without a service job", async () => {
  const create=vi.fn().mockResolvedValue({publicId:"report-id"});
  const result=await createManualAnalysis({locale:"et",listingUrl:"https://www.auto24.ee/soidukid/123456",pastedText:"  Make: Volvo  "},{analyses:{create},createToken:()=>({raw:"private-token",hash:"private-hash"})});
  expect(create).toHaveBeenCalledWith(expect.objectContaining({inputType:"pasted_text",pastedText:"Make: Volvo",captureSnapshot:{type:"fallback_required",reason:"fetch_disabled",listingUrl:"https://www.auto24.ee/soidukid/123456"}}));
  expect(create.mock.calls[0]![0]).not.toHaveProperty("serviceJobId");
  expect(result.url).toBe("/et/r/report-id#access=private-token");
 });
 it("rejects invalid links before creating a report",async()=>{
  const create=vi.fn();
  await expect(createManualAnalysis({locale:"en",listingUrl:"javascript:alert(1)"},{analyses:{create}})).rejects.toThrow("Invalid listing URL");
  expect(create).not.toHaveBeenCalled();
 });
});
