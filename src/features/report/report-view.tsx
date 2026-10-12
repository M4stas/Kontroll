"use client";

import { useState } from "react";
import { EvidenceRow } from "./evidence-row";
import { SupplementDialog } from "./supplement-dialog";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { FullReport } from "@/features/report/full-report";
import { ActivityJournal } from "@/features/report/activity-journal";
import { ReportRefresh } from "@/features/report/report-refresh";
import { ReportDeck } from "@/features/report/deck/report-deck";

interface ReportViewProps {
  locale: Locale;
  report: AnalysisReport;
  offline?: boolean;
  diagnosticsEnabled?: boolean;
}

export function ReportView({ locale, report, offline = false, diagnosticsEnabled = false }: ReportViewProps) {
  const [supplementOpen, setSupplementOpen] = useState(false);

  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>

        <ActivityJournal key={report.publicId} report={report} />

        <ReportDeck report={report} locale={locale} onSellerReplied={offline ? undefined : () => setSupplementOpen(true)} />
        {!offline ? <EvidenceRow report={report} diagnosticsEnabled={diagnosticsEnabled} onOpenSupplement={() => setSupplementOpen(true)} /> : null}

        <FullReport report={report} locale={locale} />
      </article>
      {!offline ? <SupplementDialog open={supplementOpen} onOpenChange={setSupplementOpen} publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
