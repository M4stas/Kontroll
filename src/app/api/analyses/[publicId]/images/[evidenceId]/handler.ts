import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { analysisAccessCookieName, verifyAnalysisAccess } from "@/server/access/analysis-access";
interface Dependencies {
 verifyAccess(input: {publicId:string;cookie:string|undefined}): Promise<boolean>;
 loadImage(publicId:string,evidenceId:string): Promise<{bytes:Uint8Array;mimeType:string}|null>;
}
const headers = {"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff"};
async function loadImage(publicId:string,evidenceId:string) {
 const [{getServerSupabaseClient},{AnalysesRepository},{AnalysisUploads}] = await Promise.all([import("@/server/db/client"),import("@/server/repositories/analyses"),import("@/server/storage/uploads")]);
 const client = getServerSupabaseClient();
 const source = await new AnalysesRepository(client).loadImageSource(publicId,evidenceId);
 if (!source?.storageKey) return null;
 return new AnalysisUploads(client).readImage(source.analysisId,source.storageKey,source.contentHash);
}
export function createImageHandler(dependencies: Dependencies = {verifyAccess:verifyAnalysisAccess,loadImage}) {
 return async function GET(request:NextRequest, context:{params:Promise<{publicId:string;evidenceId:string}>}) {
  const {publicId,evidenceId} = await context.params;
  if(!z.uuid().safeParse(publicId).success || !z.uuid().safeParse(evidenceId).success) return NextResponse.json({error:"Access denied"},{status:401,headers});
  try {
   if(!await dependencies.verifyAccess({publicId,cookie:request.cookies.get(analysisAccessCookieName(publicId))?.value})) return NextResponse.json({error:"Access denied"},{status:401,headers});
   const image=await dependencies.loadImage(publicId,evidenceId);
   if(!image) return NextResponse.json({error:"Image unavailable"},{status:404,headers});
   return new NextResponse(new Uint8Array(image.bytes), {headers:{...headers,"Content-Type":image.mimeType}});
  } catch {return NextResponse.json({error:"Image unavailable"},{status:503,headers});}
 };
}
