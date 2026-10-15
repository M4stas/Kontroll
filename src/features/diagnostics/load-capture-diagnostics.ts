import "server-only";
import { jobIdSchema } from "@/listings/contracts";
import { verifyAccess } from "@/server/access";
import { CaptureDiagnosticsSnapshotSchema } from "@/diagnostics/contracts";
import { DiagnosticsAccessError } from "./load-diagnostics";
import { serviceRequest, serviceDiagnosticsRequest } from "@/listings/auto24-service";
interface Dependencies {
  enabled: boolean;
  verifyAccess: typeof verifyAccess;
  serviceRequest: typeof serviceRequest;
  serviceDiagnosticsRequest: typeof serviceDiagnosticsRequest;
}
export async function loadCaptureDiagnostics(input: { jobId: string; cookie: string | undefined }, dependencies?: Dependencies) {
  if (!(dependencies?.enabled ?? process.env.LIVE_DIAGNOSTICS_ENABLED === "true")) throw new DiagnosticsAccessError(404);
  if (!jobIdSchema.safeParse(input.jobId).success || !input.cookie) throw new DiagnosticsAccessError(401);
  const deps = dependencies ?? { enabled: true, verifyAccess, serviceRequest, serviceDiagnosticsRequest };
  if (!deps.verifyAccess(input.jobId, input.cookie)) throw new DiagnosticsAccessError(401);
  const [job, capture] = await Promise.all([deps.serviceRequest(input.jobId), deps.serviceDiagnosticsRequest(input.jobId)]);
  return CaptureDiagnosticsSnapshotSchema.parse({ version: 1, serverNow: new Date().toISOString(), jobId: input.jobId, status: job.status, capture });
}
