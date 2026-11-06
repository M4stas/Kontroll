import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {getBackgroundCheck,getBackgroundCheckWithText,saveBackgroundCheck} from "@/server/repositories/background-checks";
function fake(data:unknown=null,error:unknown=null) {
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data,error}),upsert:vi.fn().mockResolvedValue({error})};
 const rpc=vi.fn().mockResolvedValue({data:null,error});
 return {query,rpc,client:{from:vi.fn(()=>query),rpc} as unknown as SupabaseClient};
}
it("returns no check for an old report",async()=>{const {client}=fake();expect(await getBackgroundCheck("analysis",client)).toBeNull();});
it("expires a stored pending lookup without leaking its identity",async()=>{
 const {client}=fake({analysis_id:"analysis",service_job_id:"job",status:"pending",reason:null,searched_by:"vin",requested_at:"2020-01-01T00:00:00Z",fetched_at:null,storage_key:null,size_bytes:null,sha256:null,updated_at:"2020-01-01T00:00:00Z"});
 expect(await getBackgroundCheck("analysis",client)).toMatchObject({status:"unavailable",reason:"timeout",storage_key:null});
});
it("does not hide database failures as absent checks",async()=>{const {client}=fake(null,{message:"database"});await expect(getBackgroundCheck("analysis",client)).rejects.toThrow("Could not load background check");});
it("persists one row per analysis",async()=>{
 const {rpc,client}=fake();
 await saveBackgroundCheck({analysis_id:"analysis",service_job_id:"job",status:"not_started",reason:null,searched_by:null,requested_at:null,fetched_at:null,storage_key:null,size_bytes:null,sha256:null},client);
 expect(rpc).toHaveBeenCalledWith("save_analysis_background_check",{p_record:expect.objectContaining({analysis_id:"analysis",status:"not_started"})});
});
it("reconciles through the analysis-locking RPC",async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{decision:"pending",run_id:"run",source_snapshot_id:"source",evidence_id:"evidence",owner_run_id:"run"},error:null});
 const {reconcileBackgroundCheck}=await import("@/server/repositories/background-checks");
 await expect(reconcileBackgroundCheck("analysis",{rpc} as unknown as SupabaseClient)).resolves.toMatchObject({decision:"pending",evidence_id:"evidence"});
 expect(rpc).toHaveBeenCalledWith("reconcile_analysis_background_check",{p_analysis_id:"analysis"});
});
it("rejects oversized extracted text before persistence",async()=>{
 const {client}=fake();
 await expect(saveBackgroundCheck({analysis_id:"analysis",service_job_id:"job",status:"fetched",reason:null,searched_by:null,requested_at:null,fetched_at:"2026-01-01T00:00:00Z",storage_key:"fixture.pdf",size_bytes:10,sha256:"a".repeat(64),text_content:"x".repeat(10001)},client)).rejects.toThrow("Background PDF text is invalid");
});

it("omits PDF text from report polling queries",async()=>{
 const {query,client}=fake();
 await getBackgroundCheck("analysis",client);
 const columns=query.select.mock.calls[0]![0].split(",").map((column:string)=>column.trim());
 expect(columns).not.toContain("*");
 expect(columns).not.toContain("text_content");
 expect(columns).toEqual(expect.arrayContaining(["status","reason","storage_key","sha256"]));
});

it("loads PDF text and ownership explicitly for workers",async()=>{
 const record={status:"fetched",text_content:"Generated fixture",owner_run_id:"run",source_snapshot_id:"source",evidence_id:"evidence"};
 const {query,client}=fake(record);
 await expect(getBackgroundCheckWithText("analysis",client)).resolves.toMatchObject(record);
 const columns=query.select.mock.calls[0]![0].split(",");
 expect(columns).not.toContain("*");
 expect(columns).toEqual(expect.arrayContaining(["text_content","owner_run_id","source_snapshot_id","evidence_id"]));
});


it.each([false, true])("recovers a legacy fetched PDF on the worker read and rejects changed bytes: %s", async (changedBytes) => {
 const analysisId = "11111111-1111-4111-8111-111111111111";
 const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length 54 >> stream\nBT /F1 12 Tf 10 100 Td (Vehicle history) Tj ET\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF");
 const record = {analysis_id: analysisId, service_job_id: "generated-fixture", status: "fetched", reason: null, searched_by: "vin", requested_at: null, fetched_at: "2026-01-01T00:00:00Z", storage_key: `${analysisId}/fixture.pdf`, size_bytes: bytes.length, sha256: changedBytes ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"), text_content: null};
 const f = fake(record);
 const download = vi.fn().mockResolvedValue({data: new Blob([bytes]), error: null});
 Object.assign(f.client, {storage: {from: () => ({download})}});
 f.rpc.mockImplementation(async (_name, {p_record}) => {
   f.query.maybeSingle.mockResolvedValue({data: p_record, error: null});
   return {data: null, error: null};
 });
 if (changedBytes) {
   await expect(getBackgroundCheckWithText(analysisId, f.client)).rejects.toThrow("Stored PDF unavailable");
   expect(f.rpc).not.toHaveBeenCalled();
 } else {
   const recovered = await getBackgroundCheckWithText(analysisId, f.client);
   expect(recovered?.text_content).toContain("Vehicle history");
   expect(f.rpc).toHaveBeenCalledWith("save_analysis_background_check", {p_record: {...record, text_content: recovered!.text_content}});
   await getBackgroundCheckWithText(analysisId, f.client);
   expect(download).toHaveBeenCalledOnce();
 }
});
