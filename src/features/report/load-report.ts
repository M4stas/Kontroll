import { AnalysisReportSchema } from "@/domain/schemas";
import { verifyAnalysisAccess } from "@/server/access/analysis-access";
import type { AnalysesRepository } from "@/server/repositories/analyses";

export class ReportAccessError extends Error {
  constructor() {
    super("Access denied");
  }
}

export interface LoadReportInput {
  publicId: string;
  cookie: string | undefined;
}

interface LoadReportDependencies {
  analyses: Pick<AnalysesRepository, "loadReport">;
  verifyAccess: (input: LoadReportInput) => Promise<boolean>;
}

async function defaultDependencies(): Promise<LoadReportDependencies> {
  const [{ AnalysesRepository }, { getServerSupabaseClient }] = await Promise.all([
    import("@/server/repositories/analyses"),
    import("@/server/db/client"),
  ]);
  return {
    analyses: new AnalysesRepository(getServerSupabaseClient()),
    verifyAccess: verifyAnalysisAccess,
  };
}

export async function loadReport(
  input: LoadReportInput,
  dependencies?: LoadReportDependencies,
) {
  const resolved = dependencies ?? await defaultDependencies();
  if (!await resolved.verifyAccess(input)) throw new ReportAccessError();
  const report = await resolved.analyses.loadReport(input.publicId);
  if (!report) return null;
  return AnalysisReportSchema.parse(report);
}
