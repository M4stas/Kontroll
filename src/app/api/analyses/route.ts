import { NextResponse } from "next/server";
import { z } from "zod";
import { createManualAnalysis } from "@/features/submission/manual-analysis";
const schema=z.object({locale:z.enum(["et","en"]),listingUrl:z.string().max(2048),pastedText:z.string().max(10000).optional()}).strict();
const headers={"Cache-Control":"private, no-store"};
export async function POST(request:Request) {
 const host=request.headers.get("host");
 let origin:string|null=null;
 try { if(host && !/[/\\?#@\s,]/.test(host)) origin=new URL(`${new URL(request.url).protocol}//${host}`).origin; } catch {}
 if(!origin || request.headers.get("origin")!==origin || request.headers.get("sec-fetch-site")==="cross-site") return NextResponse.json({error:"Access denied"},{status:403,headers});
 const parsed=schema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success) return NextResponse.json({error:"Invalid request"},{status:400,headers});
 try { return NextResponse.json(await createManualAnalysis(parsed.data),{status:201,headers}); }
 catch(error) { return NextResponse.json({error:error instanceof Error && error.message==="Invalid listing URL"?"Invalid listing URL":"Could not create the report"},{status:error instanceof Error && error.message==="Invalid listing URL"?400:503,headers}); }
}
