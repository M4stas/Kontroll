import { NextRequest } from 'next/server';
import { jobIdSchema } from '../../../../listings/contracts';
import { serviceRequest } from '../../../../listings/auto24-service';
import { cookieName, verifyAccess } from '../../../../server/access';
import { ApiError, errorResponse, jsonResponse } from '../../../../server/errors';
export const runtime = 'nodejs';
export async function GET(request: Request, context: {params: Promise<{jobId: string}>}) {
  try {
    const {jobId} = await context.params;
    const cookies = new NextRequest(request).cookies;
    if (!jobIdSchema.safeParse(jobId).success || !verifyAccess(jobId, cookies.get(cookieName(jobId))?.value)) throw new ApiError('unauthorized', 401);
    return jsonResponse(await serviceRequest(jobId));
  } catch (error) { return errorResponse(error); }
}
