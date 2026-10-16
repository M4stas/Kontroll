"use client";

import { CheckCircleIcon, CircleNotchIcon } from "@phosphor-icons/react/dist/ssr";
import { useFormatter, useTranslations } from "next-intl";
import type { AnalysisReport, Finding, Locale, SourceSummary, VehicleFact } from "@/domain/analysis";
import { EvidenceDisclosure } from "@/features/report/evidence-disclosure";
import { EvidenceImage } from "@/features/report/evidence-image";
import { findingGroup, findingGroups } from "@/features/report/primary-findings";

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

export function FullReport({ report, locale }: { report: AnalysisReport; locale: Locale }) {
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
        <p className="mt-2 text-base leading-7 full-report-muted" lang={report.locale}>{finding.explanation}</p>
        {showRecommendations && finding.nextAction ? <p className="mt-3 text-sm leading-6">
          <span className="font-semibold full-report-accent">{t("findings.nextAction")}: </span>
          <span lang={report.locale}>{finding.nextAction}</span>
        </p> : null}
        <EvidenceDisclosure triggerClassName="full-report-evidence" contentLocale={report.locale} evidence={evidence}
          issueDescription={finding.explanation} photoNumberByEvidenceId={photoNumberByEvidenceId} />
      </article>
    );
  };
  const photoCards = report.review?.images.items?.map((photo, index) => {
    const photoNumber = index + 1;
    const photoLabel = t("review.photoNumber", { number: photoNumber });
    const stateLabel = t(`review.imageStatus.${photo.state}`);
    const stateClass =
      photo.state === "complete"
        ? "full-report-accent"
        : photo.state === "running"
          ? "full-report-muted"
          : photo.state === "unavailable"
            ? "full-report-attention"
            : "full-report-muted";
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
            fallbackClassName="flex h-36 items-center justify-center px-2 text-center text-xs full-report-muted sm:h-44"
            fill sizes="(max-width: 639px) 100vw, 33vw"
            src={evidence.imageUrl} unavailableText={t("evidence.photoUnavailable")} />
        ) : <p className="flex h-36 items-center justify-center text-xs full-report-muted sm:h-44">{t("evidence.photoUnavailable")}</p>}
        <p className={`photo-caption mt-3 flex items-center justify-center gap-1.5 text-sm ${stateClass}`}>
          {photo.state === "complete" ? <span className="photo-state photo-state-complete"><CheckCircleIcon aria-hidden="true" weight="regular" /></span> : null}
          {photo.state === "running" ? <span className="photo-state photo-state-running"><CircleNotchIcon aria-hidden="true" className="motion-reduce:animate-none animate-spin" /></span> : null}
          <span className="sr-only">{stateLabel}</span>
          {photo.state !== "complete" && photo.state !== "running" ? <span>{stateLabel}</span> : null}
          <span className="full-report-muted">{photoLabel}</span>
        </p>

      </li>
    );
  });

  return (
    <details className="full-report" lang={locale} suppressHydrationWarning>
      <summary>{t("deck.fullReport")}</summary>
      <div className="full-report-content">
              <p className="mt-3 text-sm full-report-muted">{t("updated", { value: format.dateTime(new Date(report.updatedAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>
              {report.review ? <div className="text-sm full-report-muted">
                <p>{t(`review.state.${report.review.state}`)}</p>
                <p>{t("review.images", {complete: report.review.images.complete, selected: report.review.images.selected})}</p>
                <p>{t("review.text")}: {t(`review.pass.${report.review.text}`)} · {t("review.final")}: {t(`review.pass.${report.review.final}`)}</p>
                <p>{report.review.images.unavailable > 0 ? t("review.imagesUnavailable", {count: report.review.images.unavailable}) : report.review.images.skipped > 0 ? t("review.imagesSkipped", {count: report.review.images.skipped}) : t("review.imagesSupplied", {count: report.review.images.supplied})}</p>
              </div> : null}
            <section aria-labelledby="findings-title" className="mt-4">
              <h2 className="text-2xl font-semibold tracking-[-0.025em]" id="findings-title">
                {t("findings.heading")}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 full-report-muted">{t("findings.intro")}</p>

              <div className="mt-4">
              {findingGroups.map(group => {
                const grouped = priorityFindings.filter(finding => findingGroup(finding) === group);
                const photoCount = new Set(grouped.flatMap(finding => finding.evidenceIds).filter(id => report.evidence.some(item => item.id === id && item.imageUrl))).size;
                return <details suppressHydrationWarning key={group} data-finding-group={group} className="full-report-area">
                  <summary className="cursor-pointer">
                    <span className="font-semibold">{t(`compact.groups.${group}`)}</span>
                    <span className="ml-3 text-xs full-report-muted">{t("compact.counts", {findings: grouped.length, photos: photoCount})}</span>
                    <span className="mt-1 block text-sm full-report-muted" lang={grouped.length ? report.locale : locale}>{grouped[0]?.title ?? t("compact.noConcern")}</span>
                  </summary>
                  {grouped.length > 0 ? (
                <div className="mt-4 space-y-6">
                  {grouped.map(renderFinding)}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 full-report-muted">{t(report.status === "queued" || report.status === "running" ? "findings.waiting" : "findings.empty")}</p>
              )}
                </details>;
              })}
              </div>
              {(["neutral", "cleared"] as const).map(section => {
                const items = report.findings.filter(finding => section === "cleared" ? finding.state === "cleared" : finding.state !== "cleared" && findingGroup(finding) === null);
                return items.length ? <details suppressHydrationWarning key={section} className="py-3">
                  <summary className="cursor-pointer font-semibold">{t(`compact.${section}`, {count: items.length})}</summary>
                  <div className="mt-4 space-y-6">{items.map(renderFinding)}</div>
                </details> : null;
              })}
            </section>
          {report.review?.images.items?.length ? (
            <>
            {/* Firefox can restore native open state before hydration; keep that user state. */}
            <details suppressHydrationWarning className="mt-2"><summary className="cursor-pointer text-sm font-semibold">{t("compact.photosReviewed", { complete: report.review.images.complete, supplied: report.review.images.supplied })}</summary>
            <ol className="mt-4 grid list-none grid-cols-2 gap-x-4 gap-y-6 p-0 sm:grid-cols-3" aria-label={t("review.photoStatuses")}>
              {photoCards}
            </ol></details></>
          ) : null}
            <details suppressHydrationWarning className="mt-4 py-3">
              <summary className="cursor-pointer font-semibold">{t("compact.listing")}</summary>
          {report.vehicleFacts.length > 0 ? (
            <dl className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {report.vehicleFacts.map((fact) => (
                <div
                  className="min-w-0 py-3 pr-4"
                  key={`${fact.sourceId}-${fact.key}-${fact.value}`}
                >
                  <dt className="text-xs full-report-muted">{factLabel(fact, t)}</dt>
                  <dd lang={report.locale} className="mt-1 truncate text-sm font-semibold tabular-nums" title={factDisplayValue(fact)}>
                    {factDisplayValue(fact)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

            <section aria-labelledby="sources-title">
              <h2 className="text-lg font-semibold tracking-tight" id="sources-title">{t("sources.heading")}</h2>
              <div className="mt-3">
                {Object.entries(report.sources).map(([key, source]) => (
                  <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-sm" key={key}>
                    <span>{sourceLabel(key, source, t)}</span>
                    <span className="text-right full-report-muted">{t(`verification.${source.verification}`)}</span>
                  </div>
                ))}
              </div>
            </section>
            <p className="mt-3 text-sm leading-6 full-report-muted">{t("compact.methodology")}</p>
            </details>
<p className="full-report-note">{t("compact.photoLimitations")}</p>
</div>
</details>
);
}
