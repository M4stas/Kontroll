"use client";
import { useFormatter, useTranslations } from "next-intl";
import type { AnalysisReport } from "@/domain/analysis";
import { EvidenceImage } from "../evidence-image";

export function CoverCard({ report, count, showRecommendations }: { report: AnalysisReport; count: number; showRecommendations: boolean }) {
  const t = useTranslations("Report");
  const format = useFormatter();
  const makeModel = report.vehicleFacts.find(fact => fact.key === "make_model")?.value.trim() ||
    ["make", "model"].flatMap(key => {
      const fact = report.vehicleFacts.find(item => item.key === key);
      return fact?.value.trim() ? [fact.value.trim()] : [];
    }).join(" ");
  const vehicleSummary = [makeModel, ...["year", "mileage", "price"].flatMap(key => {
    const fact = report.vehicleFacts.find(item => item.key === key);
    if (!fact?.value.trim()) return [];
    const mileage = key === "mileage" && /^\d[\d ,]*\s*km$/i.test(fact.value.trim())
      ? Number(fact.value.replace(/[^\d]/g, "")) : null;
    return [mileage !== null ? `${format.number(mileage)} km` : fact.value];
  })].filter(Boolean).join(" · ");
  const photo = report.evidence.find(item => item.id === report.review?.images.items?.[0]?.evidenceId);
  return <div className="report-cover">
    {photo?.imageUrl ? <EvidenceImage key={photo.imageUrl} alt="" src={photo.imageUrl} fill containerClassName="report-cover-photo" className="object-cover" fallbackClassName="report-cover-unavailable" unavailableText="" /> : null}
    <div className="report-cover-copy">
      {vehicleSummary ? <p className="vehicle-summary" lang={report.locale}>{vehicleSummary}</p> : null}
      <h1>{showRecommendations && report.verdict ? t(`verdict.${report.verdict}`) : t("verdict.pending")}</h1>
      <p className="report-cover-lede">{count === 0 && (report.status === "queued" || report.status === "running") ? t("findings.waiting") : t("deck.coverLede", {count})}</p>
      <p className="report-status-line"><span>{t(`status.${report.status}`)}</span>{showRecommendations && report.confidence ? <> · {t("confidence", {value: t(`confidenceBand.${report.confidence}`)})}</> : null}</p>
      {!showRecommendations ? <p>{t("confidencePending")}</p> : null}
    </div>
  </div>;
}
