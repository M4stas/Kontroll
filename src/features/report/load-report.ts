import type { ReportWithBackgroundCheck, ReportBackgroundCheck } from './background-check';
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
  readBackgroundCheck?: (publicId: string) => Promise<{
    status: ReportBackgroundCheck['status']; reason: ReportBackgroundCheck['reason'];
    fetched_at: string | null; storage_key: string | null;
  } | null>;
}

async function defaultDependencies(): Promise<LoadReportDependencies> {
  const [{ AnalysesRepository }, { getServerSupabaseClient }] = await Promise.all([
    import("@/server/repositories/analyses"),
    import("@/server/db/client"),
  ]);
  return {
    analyses: new AnalysesRepository(getServerSupabaseClient()),
    verifyAccess: verifyAnalysisAccess,
    readBackgroundCheck: async (publicId) => {
      const id = await new AnalysesRepository(getServerSupabaseClient()).loadAnalysisId(publicId);
      if (!id) return null;
      const { getBackgroundCheck } = await import('@/server/repositories/background-checks');
      return getBackgroundCheck(id);
    },
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
  const parsed: ReportWithBackgroundCheck = AnalysisReportSchema.parse(report);
  const check = await resolved.readBackgroundCheck?.(input.publicId);
  if (check && check.status !== 'pending' && check.status !== 'not_requested' && parsed.review?.backgroundCheck === 'waiting') {
    // Reuse runs can inherit their parent's progress before their first worker pass.
    delete parsed.review.backgroundCheck;
  }
  if (check) parsed.backgroundCheck = {
    status: check.status, reason: check.reason,
    ...(check.status === 'fetched' && check.storage_key ? {
      pdfUrl: `/api/analyses/${input.publicId}/background-check/pdf`,
      ...(check.fetched_at ? {fetchedAt: check.fetched_at} : {}),
    } : {}),
  };
  return parsed;
}
