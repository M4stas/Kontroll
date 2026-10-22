import type { SupabaseClient } from "@supabase/supabase-js";
import { expireBackgroundCheck, type WebsiteBackgroundCheckState } from "@/listings/background-check";
async function defaultClient() {
 return (await import("@/server/db/client")).getServerSupabaseClient();
}

export type BackgroundCheckRecord = WebsiteBackgroundCheckState & {
 analysis_id: string;
 service_job_id: string;
 storage_key: string | null;
 updated_at?: string;
};
export async function getBackgroundCheck(analysisId:string,client?:SupabaseClient):Promise<BackgroundCheckRecord|null> {
 const {data,error}=await (client??await defaultClient()).from("analysis_background_checks").select("*").eq("analysis_id",analysisId).maybeSingle();
 if(error)throw new Error("Could not load background check",{cause:error});
 if(!data)return null;
 const row=data as BackgroundCheckRecord;
 return {...row,...expireBackgroundCheck(row)};
}
export async function saveBackgroundCheck(record:BackgroundCheckRecord,client?:SupabaseClient):Promise<void> {
 const {error}=await (client??await defaultClient()).from("analysis_background_checks").upsert({...record,updated_at:new Date().toISOString()},{onConflict:"analysis_id"});
 if(error)throw new Error("Could not save background check",{cause:error});
}
