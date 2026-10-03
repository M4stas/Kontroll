import type { Locale } from "@/domain/analysis";
import { createAccessToken } from "@/server/access/tokens";
import type { AnalysesRepository } from "@/server/repositories/analyses";
import { parseHttpsListingUrl } from "./listing-url";
interface Input { locale: Locale; listingUrl: string; pastedText?: string }
interface Dependencies { analyses: Pick<AnalysesRepository, "create">; createToken?: typeof createAccessToken }
export async function createManualAnalysis(input: Input, dependencies?: Dependencies) {
 const listingUrl=parseHttpsListingUrl(input.listingUrl.trim());
 if(!listingUrl || listingUrl.username || listingUrl.password) throw new Error("Invalid listing URL");
 let resolved=dependencies;
 if(!resolved) {
  const [{AnalysesRepository},{getServerSupabaseClient}]=await Promise.all([import("@/server/repositories/analyses"),import("@/server/db/client")]);
  resolved={analyses:new AnalysesRepository(getServerSupabaseClient())};
 }
 const token=(resolved.createToken ?? createAccessToken)();
 const {publicId}=await resolved.analyses.create({accessTokenHash:token.hash,locale:input.locale,listingUrl:listingUrl.href,inputType:"pasted_text",captureSnapshot:{type:"fallback_required",reason:"fetch_disabled",listingUrl:listingUrl.href},...(input.pastedText?.trim()?{pastedText:input.pastedText.trim()}:{})});
 return {url:`/${input.locale}/r/${publicId}#access=${encodeURIComponent(token.raw)}`};
}
