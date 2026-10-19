import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { analysisAccessCookieName, verifyAnalysisAccess } from "@/server/access/analysis-access";
import { isSameOriginRequest } from "@/server/http/same-origin";
interface Dependencies {
 verifyAccess(input:{publicId:string;cookie:string|undefined}):Promise<boolean>;
 loadAnalysisId(publicId:string):Promise<string|null>;
 retry(analysisId:string):Promise<boolean>;
}
const headers={"Cache-Control":"private, no-store"};
async function defaults():Promise<Dependencies> {
 const [{getServerSupabaseClient},{AnalysesRepository},{JobsRepository}]=await Promise.all([import("@/server/db/client"),import("@/server/repositories/analyses"),import("@/server/repositories/jobs")]);
 const client=getServerSupabaseClient();const analyses=new AnalysesRepository(client);const jobs=new JobsRepository(client);
 return {verifyAccess:verifyAnalysisAccess,loadAnalysisId:analyses.loadAnalysisId.bind(analyses),retry:jobs.retryCurrentReview.bind(jobs)};
}
export function createRetryHandler(dependencies?:Dependencies) {
 return async function POST(request:NextRequest,context:{params:Promise<{publicId:string}>}) {
  const {publicId}=await context.params;
  if(!z.uuid().safeParse(publicId).success) return NextResponse.json({error:"Access denied"},{status:401,headers});
  if(!isSameOriginRequest(request)) return NextResponse.json({error:"Access denied"},{status:403,headers});
  try {
   const verify=dependencies?.verifyAccess ?? verifyAnalysisAccess;
   if(!await verify({publicId,cookie:request.cookies.get(analysisAccessCookieName(publicId))?.value})) return NextResponse.json({error:"Access denied"},{status:401,headers});
   const length=Number(request.headers.get("content-length") ?? "0");
   if(!Number.isFinite(length) || length>1024) return NextResponse.json({error:"Invalid request"},{status:400,headers});
   const body=await request.text();
   if(body.trim()) {
    let parsed:unknown;try {parsed=JSON.parse(body);} catch {return NextResponse.json({error:"Invalid request"},{status:400,headers});}
    if(!z.object({}).strict().safeParse(parsed).success) return NextResponse.json({error:"Invalid request"},{status:400,headers});
   }
   const deps=dependencies ?? await defaults();const analysisId=await deps.loadAnalysisId(publicId);
   if(!analysisId) return NextResponse.json({error:"Not found"},{status:404,headers});
   if(!await deps.retry(analysisId)) return NextResponse.json({error:"Review cannot be retried"},{status:409,headers});
   return NextResponse.json({ok:true},{status:202,headers});
  } catch {return NextResponse.json({error:"Review unavailable"},{status:503,headers});}
 };
}
