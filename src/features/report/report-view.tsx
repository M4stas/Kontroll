"use client";

import { CheckCircleIcon, CircleNotchIcon } from "@phosphor-icons/react/dist/ssr";
import { useFormatter, useTranslations } from "next-intl";
import type { AnalysisReport, Finding, Locale, SourceSummary, VehicleFact } from "@/domain/analysis";
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

const findingGroups = ["bodywork", "interior", "mechanical", "identity", "mileage", "equipment"] as const;
type FindingGroup = typeof findingGroups[number];

function findingGroup(finding: Finding): FindingGroup | null {
  const explicit = finding.category.toLowerCase();
  const categoryGroups: [FindingGroup, RegExp][] = [
    ["bodywork", /body|exterior|paint|panel|rust|corrosion|kere|värv|rooste/],
    ["interior", /interior|seat|cabin|upholstery|salong|istme|iste|polster/],
    ["mechanical", /mechanic|engine|gearbox|transmission|service|maintenance|brake|tyre|tire|mootor|käigukast|hooldus|pidur|rehv/],
    ["mileage", /mileage|odometer|inspection|coverage|läbisõit|odomeeter|ülevaatus/],
    ["equipment", /equipment|feature|option|varustus/],
    ["identity", /identity|history|vin|identiteet|ajalugu/],
  ];
  const knownCategory = categoryGroups.find(([, pattern]) => pattern.test(explicit));
  if (knownCategory) return knownCategory[0];

  const subjectGroups: [FindingGroup, RegExp][] = [
    ["mileage", /mileage|odometer|inspection|coverage|technical[- ]check|\bkm\b|läbisõit|odomeeter|ülevaatus/],
    ["interior", /interior|seat|cabin|upholstery|cargo[- ]area|carpet|door pull|trim|gear[- ]selector.*surface|salong|istme|iste|polster/],
    ["equipment", /equipment|feature|option|speaker|infotainment|display|dashboard|instrument[- ]cluster|battery[- ]shaped.*indicator|comfort controls|camera|lighting|headlamp|headlight|taillight|door[- ]open|varustus/],
    ["bodywork", /bodywork|exterior|paint|panel|rust|corrosion|underbody|underside|lower[- ]body|body[- ]style|towbar|front and side surfaces|tailgate|bumper|quarter|hood|bonnet|wheel arch|front view|kere|värv|rooste/],
    ["mechanical", /mechanic|engine|gearbox|transmission|service|maintenance|brake|tyre|tire|mootor|käigukast|hooldus|pidur|rehv/],
    ["identity", /identity|history|registration|import details|\bvin\b|identiteet|ajalugu/],
  ];
  // Match the observed subject before caveats, treating speed separately from mileage.
  const subjectOf = (text: string) => text.toLowerCase()
    .split(/[.;]|\b(?:but|however|although|whereas|yet)\b/)[0]!
    .replace(/\bkm\s*\/\s*h\b/g, "");
  const titleGroup = subjectGroups.find(([, pattern]) => pattern.test(subjectOf(finding.title)));
  if (titleGroup) return titleGroup[0];
  const observedSubject = subjectOf(finding.explanation);
  return explicit === "image_observation"
    ? subjectGroups.find(([, pattern]) => pattern.test(observedSubject))?.[0] ?? null
    : null;
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

  const priorityFindings = [...openFindings].sort((a, b) =>
    ({ critical: 0, important: 1, context: 2 }[a.severity]) -
    ({ critical: 0, important: 1, context: 2 }[b.severity])
  );

  // Keep distinct subjects in the short review, without dropping critical checks.
  const uniqueFindings = priorityFindings.filter((finding, index, items) =>
    finding.severity === "critical" ||
    items.findIndex(item => item.title === finding.title && item.explanation === finding.explanation) === index
  );
  const primaryFindings: Finding[] = [];
  const primaryGroups = new Set<FindingGroup | null>();
  for (const finding of uniqueFindings) {
    const group = findingGroup(finding);
    if (finding.severity === "critical" || (primaryFindings.length < 3 && !primaryGroups.has(group))) {
      primaryFindings.push(finding);
      primaryGroups.add(group);
    }
  }
  for (const finding of uniqueFindings) {
    if (primaryFindings.length >= 3) break;
    if (!primaryFindings.includes(finding)) primaryFindings.push(finding);
  }

  const isPhotoObservation = (finding: Finding) =>
    ["bodywork", "interior", "equipment"].includes(findingGroup(finding) ?? "") &&
    finding.evidenceIds.some(id => report.evidence.some(item => item.id === id && item.imageUrl));
  if (!primaryFindings.some(isPhotoObservation)) {
    const photoObservation = uniqueFindings.find(finding =>
      isPhotoObservation(finding) && !primaryGroups.has(findingGroup(finding))
    ) ?? uniqueFindings.find(isPhotoObservation);
    if (photoObservation) primaryFindings.push(photoObservation);
  }

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
  const renderSecondaryFinding = (finding: Finding) => primaryFindings.includes(finding)
    ? <a key={finding.id} href={`#finding-${finding.id}`} className="block min-h-11 text-sm text-pale-blue underline underline-offset-4" lang={report.locale}>{finding.title}</a>
    : renderFinding(finding);

  const photoCards = report.review?.images.items?.map((photo, index) => {
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
        className="min-w-0 text-center"
        key={photo.evidenceId}
      >
        {evidence?.imageUrl ? (
          <EvidenceImage alt={photoLabel}
            className="h-36 w-full bg-ink-navy/45 object-contain sm:h-44"
            fallbackClassName="flex h-36 items-center justify-center px-2 text-center text-xs text-steel sm:h-44"
            height={176} src={evidence.imageUrl} unavailableText={t("evidence.photoUnavailable")} width={264} />
        ) : <p className="flex h-36 items-center justify-center text-xs text-steel sm:h-44">{t("evidence.photoUnavailable")}</p>}
        <p className={`mt-3 flex items-center justify-center gap-1.5 text-sm ${stateClass}`}>
          {photo.state === "complete" ? <CheckCircleIcon aria-hidden="true" weight="fill" /> : null}
          {photo.state === "running" ? <CircleNotchIcon aria-hidden="true" className="motion-reduce:animate-none animate-spin" /> : null}
          <span className="sr-only">{stateLabel}</span>
          {photo.state !== "complete" && photo.state !== "running" ? stateLabel : null}
        </p>
        <p className="mt-1 text-xs text-steel">{photoLabel}</p>
      </li>
    );
  });


  return (
    <>
      {!offline ? <ReportRefresh status={report.status} /> : null}
      <article lang={locale}>
        <header className="py-5 sm:py-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-steel">
            <span className="font-semibold text-pale-blue">{t(`status.${report.status}`)}</span>
            <span aria-hidden="true">/</span>
            <span>{t("updated", { value: format.dateTime(new Date(report.updatedAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>
          </div>
          <h1 className="mt-4 max-w-4xl text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl">
            {showRecommendations && report.verdict
              ? t(`verdict.${report.verdict}`)
              : t("verdict.pending")}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-steel">
            {showRecommendations && report.confidence
              ? t("confidence", { value: t(`confidenceBand.${report.confidence}`) })
              : t("confidencePending")}
          </p>


        </header>

        <section aria-labelledby="written-review-title" className="py-5">
          <h2 id="written-review-title" className="text-xl font-semibold">Your review</h2>
          <div className="mt-5 space-y-6">{primaryFindings.map(renderFinding)}</div>
          {!primaryFindings.length ? <p className="mt-3 text-sm leading-6 text-steel">{t(report.status === "queued" || report.status === "running" ? "findings.waiting" : "findings.empty")}</p> : null}
        </section>
        {report.review ? <section className="border-y border-steel/30 py-5" aria-labelledby="review-title">
          <h2 className="sr-only" id="review-title">{t("review.heading")}</h2>
          <p className="mt-2 text-sm leading-6 text-steel">{t(`review.state.${report.review.state}`)}</p>
          <p className="mt-1 text-sm text-steel">{t("review.images", {complete: report.review.images.complete, selected: report.review.images.selected})}</p>
          {report.review.state !== "disabled" ? <details className="mt-2"><summary className="cursor-pointer text-sm text-steel">{t("compact.reviewDetails")}</summary><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div><dt>{t("review.text")}</dt><dd className="mt-1 text-steel">{t(`review.pass.${report.review.text}`)}</dd></div>
            <div><dt>{t("compact.photos")}</dt><dd className="mt-1 text-steel">{report.review.images.supplied === 0 ? t("review.noImages") : report.review.images.unavailable > 0 ? t("review.imagesUnavailable", {count:report.review.images.unavailable}) : report.review.images.skipped > 0 ? t("review.imagesSkipped",{count:report.review.images.skipped}) : t("review.imagesSupplied",{count:report.review.images.supplied})}</dd></div>
            <div><dt>{t("review.final")}</dt><dd className="mt-1 text-steel">{t(`review.pass.${report.review.final}`)}</dd></div>
          </dl></details> : null}
          {report.review.images.items?.length ? (
            <>
            <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold">{t("compact.viewPhotos", { count: report.review.images.items.length })}</summary>
            <ol className="mt-4 grid list-none grid-cols-2 gap-x-4 gap-y-6 p-0 sm:grid-cols-3" aria-label={t("review.photoStatuses")}>
              {photoCards}
            </ol></details></>
          ) : null}
          {report.review.state === "incomplete" ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
        </section> : null}

        <div className="space-y-4 border-t border-steel/30 py-5">
          <div>
            <details className="border-y border-steel/25 py-3">
              <summary className="cursor-pointer font-semibold">All checks</summary>
            <section aria-labelledby="findings-title" className="mt-4">
              <h2 className="text-2xl font-semibold tracking-[-0.025em]" id="findings-title">
                {t("findings.heading")}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-steel">{t("findings.intro")}</p>

              <div className="mt-4 divide-y divide-steel/25 border-y border-steel/25">
              {findingGroups.map(group => {
                const grouped = priorityFindings.filter(finding => findingGroup(finding) === group);
                const photoCount = new Set(grouped.flatMap(finding => finding.evidenceIds).filter(id => report.evidence.some(item => item.id === id && item.imageUrl))).size;
                return <details key={group} data-finding-group={group} className="py-3">
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
                return items.length ? <details key={section} className="border-b border-steel/25 py-3">
                  <summary className="cursor-pointer font-semibold">{t(`compact.${section}`, {count: items.length})}</summary>
                  <div className="mt-4 space-y-6">{items.map(renderSecondaryFinding)}</div>
                </details> : null;
              })}
            </section>
            </details>

            <details className="mt-4 border-y border-steel/25 py-3">
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

          <aside className="space-y-3">
            {showRecommendations && report.actions.some(action => ["seller_question", "photo_request", "document_request"].includes(action.kind)) ? <details className="border-y border-steel/25 py-3">
              <summary className="cursor-pointer font-semibold">{t("compact.seller")}
              </summary>
              <SellerMessage actions={report.actions} contentLocale={report.locale} />
            </details> : null}
            {showRecommendations && report.actions.some(action => action.kind === "inspection_task" || action.kind === "workshop_recommendation") ? <details className="border-y border-steel/25 py-3">
              <summary className="cursor-pointer font-semibold">{t("compact.checklist")}</summary>
              <section className="mt-3">
              <h2 className="text-lg font-semibold">{t("inspection.heading")}</h2>
              <ul className="mt-3 space-y-4">
                {report.actions.filter(action => action.kind === "inspection_task" || action.kind === "workshop_recommendation").map(action => <li key={action.id} lang={report.locale}>
                  <span className="font-semibold">{action.title}</span><p className="mt-1 text-sm leading-6 text-steel">{action.instructions}</p>
                </li>)}
              </ul>
            </section></details> : null}
          </aside>
        </div>
      </article>
      {!offline ? <SupplementForm publicId={report.publicId} reportStatus={report.status} reportUpdatedAt={report.updatedAt} /> : null}
    </>
  );
}
