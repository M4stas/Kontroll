import { useTranslations } from "next-intl";
import type { AnalysisReport, Finding } from "@/domain/analysis";
import { findingGroup } from "../primary-findings";
import { EvidenceImage } from "../evidence-image";
import { EvidenceDisclosure } from "../evidence-disclosure";
import { AreaIcon } from "./area-icon";

export function FindingCard({ report, finding }: { report: AnalysisReport; finding: Finding }) {
  const t = useTranslations("Report");
  const group = findingGroup(finding);
  const evidence = report.evidence.filter(item => finding.evidenceIds.includes(item.id));
  const photo = evidence.find(item => item.imageUrl);
  const source = photo ?? evidence[0];
  const numbers = new Map(report.review?.images.items?.map((item, index) => [item.evidenceId, index + 1]) ?? []);
  const number = photo ? numbers.get(photo.id) ?? report.evidence.filter(item => item.imageUrl).findIndex(item => item.id === photo.id) + 1 : 0;
  return <div className="report-split report-finding" data-finding-id={finding.id}>
    <div className="report-card-visual">
      {photo?.imageUrl ? <EvidenceImage key={photo.imageUrl} alt={t("deck.photoSource", {number})} src={photo.imageUrl} fill containerClassName="report-finding-photo" className="object-cover" fallbackClassName="report-card-icon" fallback={<AreaIcon group={group} />} unavailableText={t("evidence.photoUnavailable")} /> : <AreaIcon group={group} />}
    </div>
    <div className="report-card-copy">
      <p className="report-card-area">{finding.severity === "critical" ? `${t("deck.critical")} · ` : ""}{group ? t(`compact.groups.${group}`) : t("deck.otherGroup")}</p>
      <h2 lang={report.locale}>{finding.title}</h2>
      <p lang={report.locale}>{finding.explanation}</p>
      <EvidenceDisclosure contentLocale={report.locale} evidence={evidence} issueDescription={finding.explanation} photoNumberByEvidenceId={numbers} triggerLabel={photo ? t("deck.photoSource", {number}) : source ? t(`sourceClass.${source.sourceClass}`) : undefined} triggerClassName="report-card-source" />
    </div>
  </div>;
}
