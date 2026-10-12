"use client";

import { useTranslations } from "next-intl";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
import { FullReport } from "@/features/report/full-report";
import { ActivityJournal } from "@/features/report/activity-journal";
import { ReportRefresh } from "@/features/report/report-refresh";
import { RetryReview } from "@/features/report/retry-review";
import { ReportDeck } from "@/features/report/deck/report-deck";
import { TaustakontrollForm } from "@/features/supplements/taustakontroll-form";
import { SupplementForm } from "@/features/supplements/supplement-form";

interface ReportViewProps {
  locale: Locale;
  report: AnalysisReport;
  offline?: boolean;
  diagnosticsEnabled?: boolean;
}

export function ReportView({ locale, report, offline = false, diagnosticsEnabled = false }: ReportViewProps) {
  const t = useTranslations("Report");

  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>
        {!offline ? <DiagnosticsPanel publicId={report.publicId} enabled={diagnosticsEnabled} /> : null}

        <ActivityJournal key={report.publicId} report={report} />

        <ReportDeck report={report} locale={locale} />
        {report.review ? <section className="border-y border-steel/30 py-5" aria-labelledby="review-title">
          <h2 className="sr-only" id="review-title">{t("review.heading")}</h2>

          {!offline && report.review.state === "incomplete" && report.activity?.state !== "running" && report.activity?.state !== "queued" ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
        </section> : null}

        {!offline ? <TaustakontrollForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} finalReviewComplete={report.review?.state === "complete" && report.review.final === "complete"} /> : null}

        <FullReport report={report} locale={locale} />
      </article>
      {!offline ? <SupplementForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
