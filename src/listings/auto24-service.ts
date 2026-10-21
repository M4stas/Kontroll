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

import { z } from "zod";
import { CaptureSpanSchema, CaptureTimingsSchema, type CaptureTimings } from "@/diagnostics/contracts";
const ServiceCaptureSpanSchema = z.object({
  span_id: CaptureSpanSchema.shape.id, attempt: CaptureSpanSchema.shape.attempt,
  phase: CaptureSpanSchema.shape.phase, state: CaptureSpanSchema.shape.state,
  started_at: CaptureSpanSchema.shape.startedAt, completed_at: CaptureSpanSchema.shape.completedAt,
  duration_ms: CaptureSpanSchema.shape.durationMs, error_code: CaptureSpanSchema.shape.errorCode,
}).strict();
const ServiceDiagnosticsSchema = z.object({
  job_id: z.string().min(1).max(128), collection: z.enum(["enabled", "disabled"]),
  spans: z.array(ServiceCaptureSpanSchema).max(64), omitted: z.number().int().nonnegative(),
}).strict();
export async function serviceDiagnosticsRequest(jobId: string): Promise<CaptureTimings> {
  const unavailable: CaptureTimings = { availability: "unavailable", spans: [], omitted: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  try {
    const { origin, key } = serviceConfig();
    const response = await fetch(`${origin}/v1/jobs/${jobId}/diagnostics`, {
      headers: { "X-API-Key": key }, cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (response.status === 404) return { availability: "not_recorded", spans: [], omitted: 0 };
    if (!response.ok) return unavailable;
    const parsed = ServiceDiagnosticsSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.job_id !== jobId) return unavailable;
    const data = parsed.data;
    return CaptureTimingsSchema.parse({
      availability: data.collection === "disabled" ? "disabled" : "available", omitted: data.omitted,
      spans: data.spans.map(span => ({ id: span.span_id, attempt: span.attempt, phase: span.phase,
        state: span.state, startedAt: span.started_at, completedAt: span.completed_at,
        durationMs: span.duration_ms, errorCode: span.error_code })),
    });
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}
