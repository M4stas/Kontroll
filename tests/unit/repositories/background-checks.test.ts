import {expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {getBackgroundCheck,saveBackgroundCheck} from "@/server/repositories/background-checks";
function fake(data:unknown=null,error:unknown=null) {
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data,error}),upsert:vi.fn().mockResolvedValue({error})};
 return {query,client:{from:vi.fn(()=>query)} as unknown as SupabaseClient};
}
it("returns no check for an old report",async()=>{const {client}=fake();expect(await getBackgroundCheck("analysis",client)).toBeNull();});
it("expires a stored pending lookup without leaking its identity",async()=>{
 const {client}=fake({analysis_id:"analysis",service_job_id:"job",status:"pending",reason:null,searched_by:"vin",requested_at:"2020-01-01T00:00:00Z",fetched_at:null,storage_key:null,size_bytes:null,sha256:null,updated_at:"2020-01-01T00:00:00Z"});
 expect(await getBackgroundCheck("analysis",client)).toMatchObject({status:"unavailable",reason:"timeout",storage_key:null});
});
it("does not hide database failures as absent checks",async()=>{const {client}=fake(null,{message:"database"});await expect(getBackgroundCheck("analysis",client)).rejects.toThrow("Could not load background check");});
it("persists one row per analysis",async()=>{
 const {query,client}=fake();
 await saveBackgroundCheck({analysis_id:"analysis",service_job_id:"job",status:"not_started",reason:null,searched_by:null,requested_at:null,fetched_at:null,storage_key:null,size_bytes:null,sha256:null},client);
 expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({analysis_id:"analysis",status:"not_started"}),{onConflict:"analysis_id"});
});
