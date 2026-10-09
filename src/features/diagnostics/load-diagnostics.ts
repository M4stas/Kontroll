import { z } from "zod";
import { verifyAnalysisAccess } from "@/server/access/analysis-access";
import type { DiagnosticsRepository } from "@/server/repositories/diagnostics";
export class DiagnosticsAccessError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Access denied" : "Not found");
  }
}
interface Input {
  publicId: string;
  cookie: string | undefined;
  runId?: string;
  executionId?: string;
  cursor?: string;
}
interface Dependencies {
  enabled: boolean;
  verifyAccess: typeof verifyAnalysisAccess;
  repository: Pick<DiagnosticsRepository, "load" | "result">;
}
async function defaults(): Promise<Dependencies> {
  const [{ getServerSupabaseClient }, { DiagnosticsRepository }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/repositories/diagnostics"),
  ]);
  return {
    enabled: process.env.LIVE_DIAGNOSTICS_ENABLED === "true",
    verifyAccess: verifyAnalysisAccess,
    repository: new DiagnosticsRepository(getServerSupabaseClient()),
  };
}
export async function loadDiagnostics(input: Input, dependencies?: Dependencies) {
  // Gate before constructing database clients, including when configuration is absent.
  if (!dependencies && process.env.LIVE_DIAGNOSTICS_ENABLED !== "true") throw new DiagnosticsAccessError(404);
  if (dependencies && !dependencies.enabled) throw new DiagnosticsAccessError(404);
  if (!z.uuid().safeParse(input.publicId).success) throw new DiagnosticsAccessError(401);
  if (!input.cookie) throw new DiagnosticsAccessError(401);
  const deps = dependencies ?? (await defaults());
  if (!(await deps.verifyAccess(input))) throw new DiagnosticsAccessError(401);
  if (
    (input.runId && !z.uuid().safeParse(input.runId).success) ||
    (input.executionId && !z.uuid().safeParse(input.executionId).success)
  )
    throw new DiagnosticsAccessError(404);
  if (input.cursor && !/^(0|[1-9][0-9]{0,5})$/.test(input.cursor)) throw new DiagnosticsAccessError(404);
  if (input.executionId) {
    if (!input.runId) throw new DiagnosticsAccessError(404);
    return deps.repository.result(input.publicId, input.runId, input.executionId);
  }
  return deps.repository.load(input.publicId, input.runId, Number(input.cursor ?? 0));
}
