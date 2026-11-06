import { AnalysisUploads } from "@/server/storage/uploads";
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
 text_content?: string | null;
 owner_run_id?: string | null;
 source_snapshot_id?: string | null;
 evidence_id?: string | null;
};
const REPORT_COLUMNS = "analysis_id,service_job_id,status,reason,searched_by,requested_at,fetched_at,storage_key,size_bytes,sha256,updated_at";
export async function getBackgroundCheck(analysisId:string,client?:SupabaseClient):Promise<BackgroundCheckRecord|null> {
 return loadBackgroundCheck(analysisId, REPORT_COLUMNS, client);
}
/** Worker reads need the extracted document and reconciliation ownership. */
export async function getBackgroundCheckWithText(analysisId:string,client?:SupabaseClient):Promise<BackgroundCheckRecord|null> {
 const workerClient = client ?? await defaultClient();
 const record = await loadBackgroundCheck(analysisId, `${REPORT_COLUMNS},text_content,owner_run_id,source_snapshot_id,evidence_id`, workerClient);
 return recoverBackgroundCheckText(record, new AnalysisUploads(workerClient), row => saveBackgroundCheck(row, workerClient));
}
export async function recoverBackgroundCheckText(
 record: BackgroundCheckRecord | null,
 uploads: Pick<AnalysisUploads, "readPdfText">,
 save: (record: BackgroundCheckRecord) => Promise<void>,
): Promise<BackgroundCheckRecord | null> {
 if (record?.status !== "fetched" || !record.storage_key || record.text_content != null) return record;
 const text = await uploads.readPdfText(record.analysis_id, record.storage_key, record.sha256!);
 const recovered = {...record, text_content: text};
 await save(recovered);
 return recovered;
}
async function loadBackgroundCheck(analysisId:string,columns:string,client?:SupabaseClient):Promise<BackgroundCheckRecord|null> {
 const {data,error}=await (client??await defaultClient()).from("analysis_background_checks").select(columns).eq("analysis_id",analysisId).maybeSingle();
 if(error)throw new Error("Could not load background check",{cause:error});
 if(!data)return null;
 const row=data as unknown as BackgroundCheckRecord;
 return {...row,...expireBackgroundCheck(row)};
}
export async function saveBackgroundCheck(record:BackgroundCheckRecord,client?:SupabaseClient):Promise<void> {
 if(record.text_content != null && (record.text_content.length === 0 || Array.from(record.text_content).length > 10000))
  throw new Error("Background PDF text is invalid");
 const {error}=await (client??await defaultClient()).rpc("save_analysis_background_check",{p_record:record});
 if(error)throw new Error("Could not save background check",{cause:error});
}

export type BackgroundCheckReconciliation = {
 decision: "pending" | "included" | "scheduled" | "not_ready";
 run_id: string | null;
 source_snapshot_id: string | null;
 evidence_id: string | null;
 owner_run_id: string | null;
};
export async function reconcileBackgroundCheck(analysisId:string,client?:SupabaseClient):Promise<BackgroundCheckReconciliation> {
 const {data,error}=await (client??await defaultClient()).rpc("reconcile_analysis_background_check",{p_analysis_id:analysisId});
 if(error || !data)throw new Error("Could not reconcile background check",{cause:error});
 return data as BackgroundCheckReconciliation;
}
