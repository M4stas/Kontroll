"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import type { AnalysisReport } from "@/domain/analysis";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
import { RetryReview } from "./retry-review";
import { TaustakontrollForm } from "@/features/supplements/taustakontroll-form";

export function EvidenceRow({ report, diagnosticsEnabled, onOpenSupplement }: {
  report: AnalysisReport;
  diagnosticsEnabled: boolean;
  onOpenSupplement: () => void;
}) {
  const t = useTranslations("Report.deck");
  const id = useId();
  return <section className="evidence-row" aria-labelledby={id}>
    <div className="evidence-row-add">
      <span id={id}>{t("addEvidence")}</span>
      <button type="button" onClick={onOpenSupplement}>{t("addEvidenceAction")}</button>
    </div>
    <TaustakontrollForm compact publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} finalReviewComplete={report.review?.state === "complete" && report.review.final === "complete"} />
    {report.review?.state === "incomplete" && report.activity?.state !== "running" && report.activity?.state !== "queued" ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
    <DiagnosticsPanel publicId={report.publicId} enabled={diagnosticsEnabled} />
  </section>;
}
