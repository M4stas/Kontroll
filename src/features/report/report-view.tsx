"use client";

import { CheckCircleIcon, CircleNotchIcon } from "@phosphor-icons/react/dist/ssr";
import { useFormatter, useTranslations } from "next-intl";
import type { AnalysisReport, Finding, Locale, SourceSummary, VehicleFact } from "@/domain/analysis";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
import { EvidenceDisclosure } from "@/features/report/evidence-disclosure";
import { EvidenceImage } from "@/features/report/evidence-image";
import { ActivityJournal } from "@/features/report/activity-journal";
import { findingGroup, findingGroups } from "@/features/report/primary-findings";
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

const factMessageKeys = new Set([
  "make_model",
  "make",
  "model",
  "year",
  "mileage",
  "fuel",
  "transmission",
  "gearbox",
  "body",
  "power",
  "drivetrain",
]);

function factDisplayValue(fact: VehicleFact) {
  return fact.key === "power" && /^\d+$/.test(fact.value.trim())
    ? `${fact.value.trim()} kW`
    : fact.value;
}

function factLabel(fact: VehicleFact, t: ReturnType<typeof useTranslations<"Report">>) {
  if (factMessageKeys.has(fact.key)) {
    return t(`facts.labels.${fact.key}` as "facts.labels.make_model");
  }
  return fact.key.replaceAll("_", " ");
}

function sourceLabel(
  key: string,
  source: SourceSummary,
  t: ReturnType<typeof useTranslations<"Report">>,
) {
  if (key === "transportAdministration") return t("sources.transportAdministration");
  if (key === "manufacturer") return t("sources.manufacturer");
  return source.label ?? t("sources.listing");
}

export function ReportView({ locale, report, offline = false, diagnosticsEnabled = false }: ReportViewProps) {
  const t = useTranslations("Report");
  const format = useFormatter();
  const showRecommendations = report.review
    ? report.review.state === "complete"
    : report.status === "complete";
  const photoNumberByEvidenceId = new Map(
    report.review?.images.items?.map((photo, index) => [photo.evidenceId, index + 1]) ?? [],
  );
  const openFindings = report.findings.filter((finding) => finding.state !== "cleared");

  const priorityFindings = [...openFindings].sort((a, b) =>
    ({ critical: 0, important: 1, context: 2 }[a.severity]) -
    ({ critical: 0, important: 1, context: 2 }[b.severity])
  );

  const renderFinding = (finding: Finding) => {
    const evidence = report.evidence.filter((item) => finding.evidenceIds.includes(item.id));
    return (
      <article id={`finding-${finding.id}`} className="max-w-2xl" key={finding.id}>
        <h3 className="text-base font-semibold leading-6" lang={report.locale}>{finding.title}</h3>
        <p className="mt-2 text-base leading-7 text-steel" lang={report.locale}>{finding.explanation}</p>
        {showRecommendations && finding.nextAction ? <p className="mt-3 text-sm leading-6">
          <span className="font-semibold text-pale-blue">{t("findings.nextAction")}: </span>
          <span lang={report.locale}>{finding.nextAction}</span>
        </p> : null}
        <EvidenceDisclosure contentLocale={report.locale} evidence={evidence}
          issueDescription={finding.explanation} photoNumberByEvidenceId={photoNumberByEvidenceId} />
      </article>
    );
  };
  const renderSecondaryFinding = renderFinding;
  const photoCards = report.review?.images.items?.map((photo, index) => {
    const photoNumber = index + 1;
    const photoLabel = t("review.photoNumber", { number: photoNumber });
    const stateLabel = t(`review.imageStatus.${photo.state}`);
    const stateClass =
      photo.state === "complete"
        ? "text-pale-blue"
        : photo.state === "running"
          ? "text-steel"
          : photo.state === "unavailable"
            ? "text-amber"
            : "text-steel";
    const evidence = report.evidence.find((item) => item.id === photo.evidenceId);

    return (
      <li
        aria-label={`${photoLabel}: ${stateLabel}`}
        className="min-w-0 text-center"
        key={photo.evidenceId}
      >
        {evidence?.imageUrl ? (
          <EvidenceImage alt={photoLabel}
            className="object-contain"
            containerClassName="relative h-36 w-full sm:h-44"
            fallbackClassName="flex h-36 items-center justify-center px-2 text-center text-xs text-steel sm:h-44"
            fill sizes="(max-width: 639px) 50vw, 33vw"
            src={evidence.imageUrl} unavailableText={t("evidence.photoUnavailable")} />
        ) : <p className="flex h-36 items-center justify-center text-xs text-steel sm:h-44">{t("evidence.photoUnavailable")}</p>}
        <p className={`photo-caption mt-3 flex items-center justify-center gap-1.5 text-sm ${stateClass}`}>
          {photo.state === "complete" ? <span className="photo-state photo-state-complete"><CheckCircleIcon aria-hidden="true" weight="regular" /></span> : null}
          {photo.state === "running" ? <span className="photo-state photo-state-running"><CircleNotchIcon aria-hidden="true" className="motion-reduce:animate-none animate-spin" /></span> : null}
          <span className="sr-only">{stateLabel}</span>
          {photo.state !== "complete" && photo.state !== "running" ? <span>{stateLabel}</span> : null}
          <span className="text-steel">{photoLabel}</span>
        </p>

      </li>
    );
  });


  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>
        {!offline ? <DiagnosticsPanel publicId={report.publicId} enabled={diagnosticsEnabled} /> : null}

        <ActivityJournal key={report.publicId} report={report} />

        <ReportDeck report={report} locale={locale} />
        {report.review ? <section className="border-y border-steel/30 py-5" aria-labelledby="review-title">
          <h2 className="sr-only" id="review-title">{t("review.heading")}</h2>
          {report.review.images.items?.length ? (
            <>
            {/* Firefox can restore native open state before hydration; keep that user state. */}
            <details suppressHydrationWarning className="mt-2"><summary className="cursor-pointer text-sm font-semibold">{t("compact.photosReviewed", { complete: report.review.images.complete, supplied: report.review.images.supplied })}</summary>
            <ol className="mt-4 grid list-none grid-cols-2 gap-x-4 gap-y-6 p-0 sm:grid-cols-3" aria-label={t("review.photoStatuses")}>
              {photoCards}
            </ol></details></>
          ) : null}
          {!offline && report.review.state === "incomplete" && report.activity?.state !== "running" && report.activity?.state !== "queued" ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
        </section> : null}

        {!offline ? <TaustakontrollForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} finalReviewComplete={report.review?.state === "complete" && report.review.final === "complete"} /> : null}

        <div className="space-y-4 border-t border-steel/30 py-5">
          <div>
            <details suppressHydrationWarning className="border-y border-steel/25 py-3">
              <summary className="cursor-pointer font-semibold">{t("compact.allChecks")}</summary>
              <p className="mt-3 text-sm text-steel">{t("updated", { value: format.dateTime(new Date(report.updatedAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>
              {report.review ? <div className="text-sm text-steel">
                <p>{t(`review.state.${report.review.state}`)}</p>
                <p>{t("review.images", {complete: report.review.images.complete, selected: report.review.images.selected})}</p>
                <p>{t("review.text")}: {t(`review.pass.${report.review.text}`)} · {t("review.final")}: {t(`review.pass.${report.review.final}`)}</p>
                <p>{report.review.images.unavailable > 0 ? t("review.imagesUnavailable", {count: report.review.images.unavailable}) : report.review.images.skipped > 0 ? t("review.imagesSkipped", {count: report.review.images.skipped}) : t("review.imagesSupplied", {count: report.review.images.supplied})}</p>
              </div> : null}
            <section aria-labelledby="findings-title" className="mt-4">
              <h2 className="text-2xl font-semibold tracking-[-0.025em]" id="findings-title">
                {t("findings.heading")}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-steel">{t("findings.intro")}</p>

              <div className="mt-4 divide-y divide-steel/25 border-y border-steel/25">
              {findingGroups.map(group => {
                const grouped = priorityFindings.filter(finding => findingGroup(finding) === group);
                const photoCount = new Set(grouped.flatMap(finding => finding.evidenceIds).filter(id => report.evidence.some(item => item.id === id && item.imageUrl))).size;
                return <details suppressHydrationWarning key={group} data-finding-group={group} className="py-3">
                  <summary className="cursor-pointer">
                    <span className="font-semibold">{t(`compact.groups.${group}`)}</span>
                    <span className="ml-3 text-xs text-steel">{t("compact.counts", {findings: grouped.length, photos: photoCount})}</span>
                    <span className="mt-1 block text-sm text-steel" lang={grouped.length ? report.locale : locale}>{grouped[0]?.title ?? t("compact.noConcern")}</span>
                  </summary>
                  {grouped.length > 0 ? (
                <div className="mt-4 space-y-6">
                  {grouped.map(renderSecondaryFinding)}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 text-steel">{t(report.status === "queued" || report.status === "running" ? "findings.waiting" : "findings.empty")}</p>
              )}
                </details>;
              })}
              </div>
              {(["neutral", "cleared"] as const).map(section => {
                const items = report.findings.filter(finding => section === "cleared" ? finding.state === "cleared" : finding.state !== "cleared" && findingGroup(finding) === null);
                return items.length ? <details suppressHydrationWarning key={section} className="border-b border-steel/25 py-3">
                  <summary className="cursor-pointer font-semibold">{t(`compact.${section}`, {count: items.length})}</summary>
                  <div className="mt-4 space-y-6">{items.map(renderSecondaryFinding)}</div>
                </details> : null;
              })}
            </section>
            </details>

            <details suppressHydrationWarning className="mt-4 border-y border-steel/25 py-3">
              <summary className="cursor-pointer font-semibold">{t("compact.listing")}</summary>
          {report.vehicleFacts.length > 0 ? (
            <dl className="mt-8 grid grid-cols-2 border-y border-steel/30 sm:grid-cols-3 lg:grid-cols-6">
              {report.vehicleFacts.map((fact) => (
                <div
                  className="min-w-0 py-3 pr-4"
                  key={`${fact.sourceId}-${fact.key}-${fact.value}`}
                >
                  <dt className="text-xs text-steel">{factLabel(fact, t)}</dt>
                  <dd className="mt-1 truncate text-sm font-semibold tabular-nums" title={factDisplayValue(fact)}>
                    {factDisplayValue(fact)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

            <section aria-labelledby="sources-title">
              <h2 className="text-lg font-semibold tracking-tight" id="sources-title">{t("sources.heading")}</h2>
              <div className="mt-3 divide-y divide-steel/20 border-y border-steel/20">
                {Object.entries(report.sources).map(([key, source]) => (
                  <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-sm" key={key}>
                    <span>{sourceLabel(key, source, t)}</span>
                    <span className="text-right text-steel">{t(`verification.${source.verification}`)}</span>
                  </div>
                ))}
              </div>
            </section>
            <p className="mt-3 text-sm leading-6 text-steel">{t("compact.methodology")}</p>
            </details>
          </div>
        </div>
      <footer className="report-footer">{t("compact.photoLimitations")}</footer>
      </article>
      {!offline ? <SupplementForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
