"use client";
import { useTranslations } from "next-intl";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { selectPrimaryFindings } from "../primary-findings";
import { composeSellerMessage } from "../seller-message-text";
import { Deck, type DeckCard } from "./deck";
import { CoverCard } from "./cover-card";
import { FindingCard } from "./finding-card";
import { MessageCard } from "./message-card";
import { ChecklistCard } from "./checklist-card";

export function ReportDeck({ report, locale, onSellerReplied }: { report: AnalysisReport; locale: Locale; onSellerReplied?: () => void }) {
  const t = useTranslations("Report");
  const primary = selectPrimaryFindings(report);
  const showRecommendations = report.review ? report.review.state === "complete" : report.status === "complete";
  const composed = composeSellerMessage(report.actions, {questions: t("seller.questions"), requests: t("seller.requests")});
  const inspections = report.actions.filter(action => action.kind === "inspection_task" || action.kind === "workshop_recommendation").filter((action, index, items) => items.findIndex(item => item.instructions === action.instructions) === index);
  const cards: DeckCard[] = [{id: "cover", name: t("deck.coverName"), content: <CoverCard report={report} count={primary.length} showRecommendations={showRecommendations} />}];
  for (const finding of primary) cards.push({id: `finding-${finding.id}`, name: finding.title, content: <FindingCard report={report} finding={finding} />});
  if (showRecommendations && composed.count > 0) cards.push({id: "message", name: t("deck.messageName"), content: <MessageCard {...composed} locale={report.locale} onSellerReplied={onSellerReplied} />});
  if (showRecommendations && inspections.length) cards.push({id: "checklist", name: t("checklist.heading"), content: <ChecklistCard key={report.publicId} report={report} actions={inspections} />});
  return <div lang={locale}><Deck label={t("deck.label")} cards={cards} firstNextLabel={t("deck.firstNext")} /></div>;
}
