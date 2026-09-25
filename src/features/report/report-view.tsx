"use client";

import { WarningIcon } from "@phosphor-icons/react/dist/ssr";
import { useFormatter, useTranslations } from "next-intl";
import { Separator } from "@/components/ui/separator";
import type { AnalysisReport, Locale, SourceSummary, VehicleFact } from "@/domain/analysis";
import { EvidenceDisclosure } from "@/features/report/evidence-disclosure";
import { ReportRefresh } from "@/features/report/report-refresh";
import { SellerMessage } from "@/features/report/seller-message";
import { SupplementForm } from "@/features/supplements/supplement-form";
import { ViewingChecklist } from "@/features/report/viewing-checklist";

interface ReportViewProps {
  locale: Locale;
  report: AnalysisReport;
  offline?: boolean;
}

const factMessageKeys = new Set(["make_model", "year", "mileage", "fuel", "transmission", "body"]);

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
            {report.verdict ? t(`verdict.${report.verdict}`) : t("verdict.pending")}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-steel">
            {report.confidence
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
                  <dd className="mt-1 truncate text-sm font-semibold tabular-nums" title={fact.value}>
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </header>

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
                        <p className="mt-3 max-w-2xl text-sm leading-6">
                          <span className="font-semibold text-pale-blue">{t("findings.nextAction")}: </span>
                          <span lang={report.locale}>{finding.nextAction}</span>
                        </p>
                        <EvidenceDisclosure contentLocale={report.locale} evidence={evidence} />
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 text-steel">{t("findings.empty")}</p>
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
            <SellerMessage actions={report.actions} contentLocale={report.locale} />
            <ViewingChecklist actions={report.actions} contentLocale={report.locale} publicId={report.publicId} />
          </aside>
        </div>
      </article>
      {!offline ? <SupplementForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
