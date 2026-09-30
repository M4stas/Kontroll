import type { ApiErrorCode } from '../listings/contracts';
export class ApiError extends Error {
  constructor(public code: ApiErrorCode, public status: number) { super(code); }
}
export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {status, headers: {'Cache-Control': 'private, no-store'}});
}
export function errorResponse(error: unknown) {
  const failure = error instanceof ApiError ? error : new ApiError('service_unavailable', 503);
  return jsonResponse({error: {code: failure.code}}, failure.status);
}
