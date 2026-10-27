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
