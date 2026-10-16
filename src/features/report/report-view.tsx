"use client";

import { useState } from "react";
import { EvidenceRow } from "./evidence-row";
import { SupplementDialog } from "./supplement-dialog";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { FullReport } from "@/features/report/full-report";
import { ReportCompletion, ReportProgress } from "./report-progress";
import { activityState } from "./activity-state";
import { canOpenReport } from "./activity-steps";
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
  const [opened, setOpened] = useState(() => offline || (
    canOpenReport(activityState(report, Infinity, true)) &&
    report.activity?.state !== "queued" && report.activity?.state !== "running"
  ));
  const [previousActivity, setPreviousActivity] = useState(report.activity);
  if (previousActivity?.state !== report.activity?.state || previousActivity?.runId !== report.activity?.runId) {
    setPreviousActivity(report.activity);
    // A resumed stale run keeps its run ID; a seller answer or PDF starts a new one.
    const newRun = previousActivity?.state === undefined || previousActivity.state === "stopped" ||
      (previousActivity.runId !== undefined && report.activity?.runId !== undefined && previousActivity.runId !== report.activity.runId);
    if (opened && newRun && (report.activity?.state === "queued" || report.activity?.state === "running")) {
      setOpened(false);
    }
  }
  const showReport = offline || opened;

  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>
        {showReport ? <>
          <ReportCompletion report={report} />
          <ReportDeck report={report} locale={locale} onSellerReplied={offline ? undefined : () => setSupplementOpen(true)} />
          {!offline ? <EvidenceRow report={report} diagnosticsEnabled={diagnosticsEnabled} onOpenSupplement={() => setSupplementOpen(true)} /> : null}
          <FullReport report={report} locale={locale} />
        </> : <ReportProgress report={report} diagnosticsEnabled={diagnosticsEnabled} onOpen={() => {
          setOpened(true);
          if (window.matchMedia("(max-width: 639px)").matches) {
            window.scrollTo({ top: 0, behavior: "auto" });
          }
        }} />}
      </article>
      {!offline && showReport ? <SupplementDialog open={supplementOpen} onOpenChange={setSupplementOpen} publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
