"use client";

import { CheckCircleIcon, CircleNotchIcon, WarningIcon } from "@phosphor-icons/react/dist/ssr";
import { useFormatter, useTranslations } from "next-intl";
import { Separator } from "@/components/ui/separator";
import type { AnalysisReport, Locale, SourceSummary, VehicleFact } from "@/domain/analysis";
import { EvidenceDisclosure } from "@/features/report/evidence-disclosure";
import { EvidenceImage } from "@/features/report/evidence-image";
import { ReportRefresh } from "@/features/report/report-refresh";
import { RetryReview } from "@/features/report/retry-review";
import { SellerMessage } from "@/features/report/seller-message";
import { SupplementForm } from "@/features/supplements/supplement-form";

interface ReportViewProps {
  locale: Locale;
  report: AnalysisReport;
  offline?: boolean;
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

export function ReportView({ locale, report, offline = false }: ReportViewProps) {
  const t = useTranslations("Report");
  const format = useFormatter();
  const showRecommendations = report.review
    ? report.review.state === "complete"
    : report.status === "complete";
  const photoNumberByEvidenceId = new Map(
    report.review?.images.items?.map((photo, index) => [photo.evidenceId, index + 1]) ?? [],
  );
  const openFindings = report.findings.filter((finding) => finding.state !== "cleared");

  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>
        <header className="py-9 sm:py-12">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-steel">
            <span className="font-semibold text-pale-blue">{t(`status.${report.status}`)}</span>
            <span aria-hidden="true">/</span>
            <span>{t("updated", { value: format.dateTime(new Date(report.updatedAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>
          </div>
          <h1 className="mt-4 max-w-4xl text-4xl font-semibold leading-[1.02] tracking-[-0.045em] sm:text-6xl md:text-7xl">
            {showRecommendations && report.verdict
              ? t(`verdict.${report.verdict}`)
              : t("verdict.pending")}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-steel">
            {showRecommendations && report.confidence
              ? t("confidence", { value: t(`confidenceBand.${report.confidence}`) })
              : t("confidencePending")}
          </p>

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
        </header>

        {report.review ? <section className="border-y border-steel/30 py-5" aria-labelledby="review-title">
          <h2 className="text-lg font-semibold" id="review-title">{t("review.heading")}</h2>
          <p className="mt-2 text-sm leading-6 text-steel">{t(`review.state.${report.review.state}`)}</p>
          {report.review.state !== "disabled" ? <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div><dt>{t("review.text")}</dt><dd className="mt-1 text-steel">{t(`review.pass.${report.review.text}`)}</dd></div>
            <div><dt>{t("review.images", {complete: report.review.images.complete, selected:report.review.images.selected})}</dt><dd className="mt-1 text-steel">{report.review.images.supplied === 0 ? t("review.noImages") : report.review.images.unavailable > 0 ? t("review.imagesUnavailable", {count:report.review.images.unavailable}) : report.review.images.skipped > 0 ? t("review.imagesSkipped",{count:report.review.images.skipped}) : t("review.imagesSupplied",{count:report.review.images.supplied})}</dd></div>
            <div><dt>{t("review.final")}</dt><dd className="mt-1 text-steel">{t(`review.pass.${report.review.final}`)}</dd></div>
          </dl> : null}
          {report.review.images.items?.length ? (
            <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("review.photoStatuses")}>
              {report.review.images.items.map((photo, index) => {
                const photoNumber = index + 1;
                const photoLabel = t("review.photoNumber", { number: photoNumber });
                const stateLabel = t(`review.imageStatus.${photo.state}`);
                const stateClass =
                  photo.state === "complete"
                    ? "text-green-400"
                    : photo.state === "running"
                      ? "text-orange-400"
                      : photo.state === "unavailable"
                        ? "text-amber"
                        : "text-steel";
                const evidence = report.evidence.find((item) => item.id === photo.evidenceId);

                return (
                  <li
                    aria-label={`${photoLabel}: ${stateLabel}`}
                    className="flex min-h-20 items-center justify-between gap-3 border border-steel/25 p-3"
                    key={photo.evidenceId}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-steel">{photoLabel}</p>
                      <p className={`mt-1 flex items-center gap-1.5 text-sm ${stateClass}`}>
                        {photo.state === "complete" ? <CheckCircleIcon aria-hidden="true" weight="fill" /> : null}
                        {photo.state === "running" ? <CircleNotchIcon aria-hidden="true" className="motion-reduce:animate-none animate-spin" /> : null}
                        {stateLabel}
                      </p>
                    </div>
                    {evidence?.imageUrl ? (
                      <EvidenceImage
                        alt={photoLabel}
                        className="h-16 w-24 rounded-sm bg-ink-navy/45 object-contain"
                        fallbackClassName="flex h-16 w-24 shrink-0 items-center justify-center rounded-sm border border-steel/25 px-2 text-center text-xs text-steel"
                        height={64}
                        src={evidence.imageUrl}
                        unavailableText={t("evidence.photoUnavailable")}
                        width={96}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {report.review.state === "incomplete" ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
        </section> : null}

        <div className="grid gap-10 border-t border-steel/30 py-8 lg:grid-cols-[minmax(0,1.7fr)_minmax(17rem,0.8fr)] lg:gap-12">
          <div>
            <section aria-labelledby="findings-title">
              <h2 className="text-2xl font-semibold tracking-[-0.025em]" id="findings-title">
                {t("findings.heading")}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-steel">{t("findings.intro")}</p>

              {openFindings.length > 0 ? (
                <div className="mt-6 space-y-8">
                  {openFindings.map((finding) => {
                    const evidence = report.evidence.filter((item) => finding.evidenceIds.includes(item.id));
                    return (
                      <article className="border-l-2 border-amber pl-4 sm:pl-5" key={finding.id}>
                        <div className="flex items-start gap-2 text-amber">
                          <WarningIcon aria-hidden="true" className="mt-0.5 shrink-0" weight="fill" />
                          <h3
                            className="text-base font-semibold leading-6 text-foreground"
                            lang={report.locale}
                          >
                            {finding.title}
                          </h3>
                        </div>
                        <p
                          className="mt-2 max-w-2xl text-sm leading-6 text-steel"
                          lang={report.locale}
                        >
                          {finding.explanation}
                        </p>
                        {showRecommendations ? <p className="mt-3 max-w-2xl text-sm leading-6">
                          <span className="font-semibold text-pale-blue">{t("findings.nextAction")}: </span>
                          <span lang={report.locale}>{finding.nextAction}</span>
                        </p> : null}
                        <EvidenceDisclosure
                          contentLocale={report.locale}
                          evidence={evidence}
                          issueDescription={finding.explanation}
                          photoNumberByEvidenceId={photoNumberByEvidenceId}
                        />
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 text-steel">{t(report.status === "queued" || report.status === "running" ? "findings.waiting" : "findings.empty")}</p>
              )}
            </section>

            <Separator className="my-9 bg-steel/30" />

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
          </div>

          <aside className="space-y-8">
            {showRecommendations ? <SellerMessage actions={report.actions} contentLocale={report.locale} /> : null}
            {showRecommendations && report.actions.some(action => action.kind === "inspection_task" || action.kind === "workshop_recommendation") ? <section>
              <h2 className="text-lg font-semibold">{t("inspection.heading")}</h2>
              <ul className="mt-3 space-y-4">
                {report.actions.filter(action => action.kind === "inspection_task" || action.kind === "workshop_recommendation").map(action => <li key={action.id} lang={report.locale}>
                  <span className="font-semibold">{action.title}</span><p className="mt-1 text-sm leading-6 text-steel">{action.instructions}</p>
                </li>)}
              </ul>
            </section> : null}
          </aside>
        </div>
      </article>
      {!offline ? <SupplementForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
