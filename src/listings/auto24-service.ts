import 'server-only';
import { serviceConfig } from '../config/env';
import { ApiError } from '../server/errors';
import { jobSchema, type ListingJob } from './contracts';
export const SERVICE_TIMEOUT_MS = 10000;
export async function serviceRequest(jobId?: string, listingUrl?: string): Promise<ListingJob> {
  const {origin, key} = serviceConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/v1/jobs${jobId ? `/${jobId}` : ''}`, {
      method: jobId ? 'GET' : 'POST', headers: {'X-API-Key': key, 'Content-Type': 'application/json'},
      body: jobId ? undefined : JSON.stringify({url: listingUrl}), cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if ([401,403].includes(response.status)) throw new ApiError('service_auth_error', 503);
    if (response.status === 404 && jobId) throw new ApiError('job_not_found', 404);
    if (!response.ok) throw new ApiError('service_unavailable', 503);
    const payload = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ApiError('service_unavailable', 503);
      throw new ApiError('invalid_service_response', 502);
    });
    const parsed = jobSchema.safeParse(payload);
    if (!parsed.success || (jobId && parsed.data.job_id !== jobId) || (!jobId && (response.status !== 202 || parsed.data.status !== 'queued'))) throw new ApiError('invalid_service_response', 502);
    const job = parsed.data;
    return {...job, error: job.error ? {code: job.error.code} : null};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', 503);
  } finally { clearTimeout(timer); }
}
