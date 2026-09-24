"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { AnalysisReportSchema } from "@/domain/schemas";
import { cacheReport, clearCachedReport, loadCachedReport } from "@/features/offline/report-cache";
import { messageWorker } from "@/features/offline/register-worker";
import { ReportView } from "@/features/report/report-view";

interface Props {
  locale: Locale;
  publicId: string;
  serverReport: AnalysisReport | null;
  accessFallback: ReactNode;
}

type State = "loading" | "available" | "offline" | "removed" | "missing" | "unavailable";

export function OfflineReport({ locale, publicId, serverReport, accessFallback }: Props) {
  const t = useTranslations("Report.offline");
  const [report, setReport] = useState(serverReport);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let response: Response;
      try {
        response = await fetch(`/api/analyses/${publicId}/report`, { cache: "no-store" });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof TypeError) {
          try {
            const cached = await loadCachedReport(publicId);
            if (cancelled) return;
            setReport(cached);
            setState(cached ? "offline" : "missing");
          } catch {
            if (!cancelled) setState("missing");
          }
        } else {
          setState("unavailable");
        }
        return;
      }
      if (!response.ok) {
        if (!cancelled) setState("unavailable");
        return;
      }
      let validated: AnalysisReport;
      try {
        validated = AnalysisReportSchema.parse(await response.json());
        if (validated.publicId !== publicId) throw new Error("Report ID mismatch");
      } catch {
        if (!cancelled) setState("unavailable");
        return;
      }
      if (cancelled) return;
      setReport(validated);
      try {
        await cacheReport(publicId, validated);
        const shellSaved = await messageWorker("CACHE_REPORT_SHELL", `/${locale}/a/${publicId}`);
        if (!cancelled && shellSaved) setState("available");
      } catch {
        // The online report remains readable when browser storage is unavailable.
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [locale, publicId, serverReport]);

  const clear = async () => {
    await clearCachedReport(publicId);
    await messageWorker("CLEAR_REPORT_SHELL", `/${locale}/a/${publicId}`);
    setState("removed");
  };

  if (state === "missing") return <p className="py-16 text-steel" role="status">{t("missing")}</p>;
  if (!report || state === "unavailable") return accessFallback;

  return (
    <>
      {state !== "loading" ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-accent bg-card px-4 py-2 text-sm" role="status">
          <p className="min-w-0 leading-6 text-foreground">
            <span className="font-semibold text-accent">{t(state === "offline" ? "offline" : state === "removed" ? "removed" : "available")}</span>
            {state === "offline" ? <span className="ml-2 text-steel">{t("stale")}</span> : null}
          </p>
          {state !== "removed" ? (
            <button
              className="min-h-11 rounded-sm px-3 text-left font-semibold text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => void clear()}
              type="button"
            >
              {t("clear")}
            </button>
          ) : null}
        </div>
      ) : null}
      <ReportView locale={locale} report={report} offline={state === "offline"} />
    </>
  );
}
