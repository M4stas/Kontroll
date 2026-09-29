import type { NextRequest } from 'next/server';
import { jobIdSchema } from '../../../../listings/contracts';
import { serviceRequest } from '../../../../listings/auto24-service';
import { cookieName, readAccessSourceUrl, verifyAccess } from '../../../../server/access';
import { ApiError, errorResponse, jsonResponse } from '../../../../server/errors';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, context: {params: Promise<{jobId: string}>}) {
  try {
    const {jobId} = await context.params;
    const cookies = request.cookies;
    if (!jobIdSchema.safeParse(jobId).success || !verifyAccess(jobId, cookies.get(cookieName(jobId))?.value)) throw new ApiError('unauthorized', 401);
    const job = await serviceRequest(jobId);
    const sourceUrl = readAccessSourceUrl(jobId, cookies.get(cookieName(jobId))?.value);
    return jsonResponse({...job, ...(sourceUrl ? {source_url: sourceUrl} : {})});
  } catch (error) { return errorResponse(error); }
}
