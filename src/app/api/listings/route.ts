import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canonicalListingUrl } from '../../../listings/contracts';
import { serviceRequest } from '../../../listings/auto24-service';
import { ACCESS_TTL, cookieName, issueAccess } from '../../../server/access';
import { ApiError, errorResponse } from '../../../server/errors';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError('forbidden', 403);
    const parsed = z.object({listingUrl: z.string().max(2048)}).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError('invalid_request', 400);
    let url: string;
    try { url = canonicalListingUrl(parsed.data.listingUrl); } catch { throw new ApiError('invalid_url', 400); }
    const job = await serviceRequest(undefined, url);
    const response = NextResponse.json({jobId: job.job_id}, {status: 202, headers: {'Cache-Control': 'private, no-store'}});
    response.cookies.set(cookieName(job.job_id), issueAccess(job.job_id), {httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: ACCESS_TTL});
    return response;
  } catch (error) { return errorResponse(error); }
}
