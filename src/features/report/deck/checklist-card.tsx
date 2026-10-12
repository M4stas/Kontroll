"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ListChecksIcon } from "@phosphor-icons/react/dist/ssr";
import type { Action, AnalysisReport } from "@/domain/analysis";
import { findingGroup } from "../primary-findings";
import { EvidenceImage } from "../evidence-image";
import { AreaIcon } from "./area-icon";

export function ChecklistCard({ report, actions }: { report: AnalysisReport; actions: Action[] }) {
  const t = useTranslations("Report");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const done = actions.filter(action => checked.has(action.instructions)).length;
  return <div className="report-split report-checklist">
    <div className="report-card-copy"><h2>{t("checklist.heading")}</h2><p>{t("checklist.intro")}</p><p className="report-checklist-count" aria-live="polite">{t("deck.checkedCount", {done, total: actions.length})}</p></div>
    <ul className="report-checklist-rows">{actions.map(action => {
      const finding = report.findings.find(item => item.id === action.findingId);
      const photo = finding && report.evidence.find(item => finding.evidenceIds.includes(item.id) && item.imageUrl);
      const fallback = finding ? <AreaIcon group={findingGroup(finding)} /> : <ListChecksIcon aria-hidden="true" weight="thin" />;
      return <li key={action.instructions}><label>
        <input type="checkbox" checked={checked.has(action.instructions)} onChange={event => setChecked(previous => {const next = new Set(previous); if (event.target.checked) next.add(action.instructions); else next.delete(action.instructions); return next;})} />
        <span className="report-checklist-thumb">{photo?.imageUrl ? <EvidenceImage key={photo.imageUrl} alt="" src={photo.imageUrl} width={64} height={64} className="object-cover" fallbackClassName="report-checklist-icon" fallback={fallback} unavailableText="" /> : fallback}</span>
        <span lang={report.locale}><strong>{action.title}</strong><span className="report-checklist-instructions">{action.instructions}</span></span>
      </label></li>;
    })}</ul>
  </div>;
}
