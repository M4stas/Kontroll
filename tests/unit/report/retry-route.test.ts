import {NextRequest} from "next/server";
import {describe,it,expect,vi} from "vitest";
import {createRetryHandler} from "@/app/api/analyses/[publicId]/retry/handler";
const publicId="12345678-1234-4234-8234-123456789abc";
const context={params:Promise.resolve({publicId})};
function request(origin="https://kontroll.test"){return new NextRequest(`https://kontroll.test/api/analyses/${publicId}/retry`,{method:"POST",headers:{host:"kontroll.test",origin}});}
describe("private review retry",()=>{
 it("rejects submitted model controls before retrying",async()=>{
 const retry=vi.fn();const req=new NextRequest(`https://kontroll.test/api/analyses/${publicId}/retry`,{method:"POST",headers:{host:"kontroll.test",origin:"https://kontroll.test"},body:JSON.stringify({model:"override"})});
 const response=await createRetryHandler({verifyAccess:async()=>true,loadAnalysisId:async()=>"analysis-id",retry})(req,context);
 expect(response.status).toBe(400);expect(retry).not.toHaveBeenCalled();
 });

 it("retries the current review under private access",async()=>{
 const retry=vi.fn().mockResolvedValue(true);
 const response=await createRetryHandler({verifyAccess:async()=>true,loadAnalysisId:async()=>"analysis-id",retry})(request(),context);
 expect(response.status).toBe(202);expect(retry).toHaveBeenCalledWith("analysis-id");expect(response.headers.get("cache-control")).toBe("private, no-store");
 });
 it("denies private-access failure before enqueueing",async()=>{
 const retry=vi.fn();const response=await createRetryHandler({verifyAccess:async()=>false,loadAnalysisId:async()=>"analysis-id",retry})(request(),context);
 expect(response.status).toBe(401);expect(retry).not.toHaveBeenCalled();
 });
 it("rejects cross-origin requests even with private access",async()=>{
 const retry=vi.fn();const response=await createRetryHandler({verifyAccess:async()=>true,loadAnalysisId:async()=>"analysis-id",retry})(request("https://attacker.test"),context);
 expect(response.status).toBe(403);expect(retry).not.toHaveBeenCalled();
 });
});
