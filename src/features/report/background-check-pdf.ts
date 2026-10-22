import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analysisAccessCookieName, verifyAnalysisAccess } from '@/server/access/analysis-access';

interface Dependencies {
  verifyAccess(input: {publicId: string; cookie: string | undefined}): Promise<boolean>;
  loadPdf(publicId: string): Promise<Uint8Array<ArrayBuffer> | null>;
}
const headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'};

async function loadPdf(publicId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const [{getServerSupabaseClient}, {AnalysesRepository}, {getBackgroundCheck}] = await Promise.all([
    import('@/server/db/client'), import('@/server/repositories/analyses'), import('@/server/repositories/background-checks'),
  ]);
  const client = getServerSupabaseClient();
  const analysisId = await new AnalysesRepository(client).loadAnalysisId(publicId);
  if (!analysisId) return null;
  const check = await getBackgroundCheck(analysisId, client);
  if (check?.status !== 'fetched' || !check.storage_key) return null;
  if (!check.storage_key.startsWith(`${analysisId}/`) || check.storage_key.includes('..') || check.storage_key.includes('\\')) throw new Error('PDF unavailable');
  const {data, error} = await client.storage.from('analysis-uploads').download(check.storage_key);
  if (error || !data || data.size > 12 * 1024 * 1024) throw new Error('PDF unavailable');
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== check.size_bytes || bytes.byteLength > 12 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== check.sha256 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDF unavailable');
  return bytes;
}

export function createBackgroundCheckPdfHandler(dependencies: Dependencies = {verifyAccess: verifyAnalysisAccess, loadPdf}) {
  return async function GET(request: NextRequest, context: {params: Promise<{publicId: string}>}) {
    const {publicId} = await context.params;
    if (!z.uuid().safeParse(publicId).success) return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
    try {
      if (!await dependencies.verifyAccess({publicId, cookie: request.cookies.get(analysisAccessCookieName(publicId))?.value})) {
        return NextResponse.json({error: 'Access denied'}, {status: 401, headers});
      }
      const bytes = await dependencies.loadPdf(publicId);
      if (!bytes) return NextResponse.json({error: 'PDF unavailable'}, {status: 404, headers});
      return new NextResponse(bytes, {headers: {...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="background-check.pdf"'}});
    } catch {
      return NextResponse.json({error: 'PDF unavailable'}, {status: 503, headers});
    }
  };
}
