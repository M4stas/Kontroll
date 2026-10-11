"use client";

import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ReportActions } from "@/features/submission/report-actions";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  jobErrorCodeSchema,
  jobIdSchema,
  listingSchema,
  type Listing,
  type ListingJob,
} from "@/listings/contracts";
import {
  createListingPoller,
  isSlowWait,
  ListingPollTerminalError,
  POLL_WINDOW_MS,
  type ListingPollTerminalCode,
} from "./polling";
import { listingText, type Locale } from "./messages";
import { formatDateTime } from "./formatters";
import {
  getListingJobUrlServerSnapshot,
  getPollStartedAtServerSnapshot,
  getPollStartedAtSnapshot,
  readListingJobUrl,
  savePollStartedAt,
  subscribeListingJobUrl,
  subscribePollStartedAt,
} from "./session-storage";

export const browserListingJobSchema = z.object({
  source_url: listingSchema.shape.source_url.optional(),
  job_id: jobIdSchema,
  status: z.enum(["queued", "running", "completed", "failed"]),
  submitted_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  parsed_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()).nullable().default(null),
  listing: listingSchema.nullable().default(null),
  error: z.object({ code: jobErrorCodeSchema }).nullable().default(null),
  warnings: z.array(z.string()).default([]),
}).refine((job) => {
  if (job.status === "completed") return job.listing !== null && job.parsed_at !== null && job.error === null;
  if (job.status === "failed") return job.listing === null && job.parsed_at === null && job.error !== null;
  return job.listing === null && job.parsed_at === null && job.error === null;
});

const terminalPollCodes = new Set<ListingPollTerminalCode>([
  "unauthorized",
  "forbidden",
  "job_not_found",
  "configuration_error",
  "service_auth_error",
  "invalid_service_response",
]);

interface DashboardProps {
  submittedSourceUrl?: string;
  locale: Locale;
  jobId: string;
}

type StatusNotice = "connection" | "paused" | null;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function getListingJob(jobId: string, signal: AbortSignal): Promise<ListingJob> {
  const response = await fetch(`/api/listings/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const root = record(body);
    const error = record(root?.error);
    const code = typeof error?.code === "string" ? error.code : null;
    if (code && terminalPollCodes.has(code as ListingPollTerminalCode)) {
      throw new ListingPollTerminalError(code as ListingPollTerminalCode);
    }
    throw new Error("Listing status request failed");
  }

  const parsed = browserListingJobSchema.safeParse(body);
  if (!parsed.success || parsed.data.job_id !== jobId) {
    throw new ListingPollTerminalError("invalid_service_response");
  }
  return parsed.data as ListingJob;
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "et" ? "et-EE" : "en-GB").format(value);
}

function formatElapsed(milliseconds: number, locale: Locale): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return listingText(locale, "seconds", { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return listingText(locale, "minutesSeconds", { minutes, seconds: seconds % 60 });
  return listingText(locale, "hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function factsFor(listing: Listing, locale: Locale): Array<{ label: string; value: string }> {
  const unavailable = listingText(locale, "unavailable");
  const text = (value: string | number | null): string => value === null || value === ""
    ? unavailable
    : typeof value === "number"
      ? formatNumber(value, locale)
      : value;
  const numberWithUnit = (value: number | null, unit: string) => value === null
    ? unavailable
    : `${formatNumber(value, locale)} ${unit}`;
  const price = listing.price?.amount === null || listing.price === null
    ? unavailable
    : `${formatNumber(listing.price.amount, locale)}${listing.price.currency ? ` ${listing.price.currency}` : ""}`;

  return [
    { label: listingText(locale, "make"), value: text(listing.make) },
    { label: listingText(locale, "model"), value: text(listing.model) },
    { label: listingText(locale, "year"), value: listing.year === null ? unavailable : String(listing.year) },
    { label: listingText(locale, "firstRegistration"), value: text(listing.first_registration) },
    { label: listingText(locale, "listingPrice"), value: price },
    { label: listingText(locale, "mileage"), value: numberWithUnit(listing.mileage_km, "km") },
    { label: listingText(locale, "fuel"), value: text(listing.fuel) },
    { label: listingText(locale, "power"), value: numberWithUnit(listing.power_kw, "kW") },
    { label: listingText(locale, "gearbox"), value: text(listing.gearbox) },
    { label: listingText(locale, "drivetrain"), value: text(listing.drivetrain) },
    { label: listingText(locale, "bodyType"), value: text(listing.body_type) },
    { label: listingText(locale, "colour"), value: text(listing.colour) },
    { label: listingText(locale, "listingId"), value: text(listing.listing_id) },
  ];
}

export function ListingAccessFallback({
  locale,
  jobId,
  code,
  sourceUrl,
  onCheckAgain,
}: {
  locale: Locale;
  jobId: string;
  code?: ListingPollTerminalCode;
  sourceUrl?: string | null;
  onCheckAgain?: () => void;
}) {
  const isMissing = code === "job_not_found";
  const isServiceError = code && !["unauthorized", "forbidden", "job_not_found"].includes(code);
  const title = isMissing
    ? listingText(locale, "listingUnavailableTitle")
    : isServiceError
      ? code === "invalid_service_response"
        ? listingText(locale, "serviceResponseInvalid")
        : listingText(locale, "serviceConfig")
      : listingText(locale, "privatePageTitle");
  const description = isMissing
    ? listingText(locale, "listingUnavailableHelp")
    : isServiceError
      ? listingText(locale, "serviceUnavailable")
      : listingText(locale, "accessHelp");
  const safeSource = safeHttpUrl(sourceUrl);

  return (
    <main className="page-shell" lang={locale}>
      <SiteHeader locale={locale} languageHrefs={{ et: `/et/a/${encodeURIComponent(jobId)}`, en: `/en/a/${encodeURIComponent(jobId)}` }} showNewListing />
      <section className="access-panel" role="alert">
        <h1>{title}</h1>
        <p>{description}</p>
        {safeSource ? (
          <p><a className="source-link" href={safeSource} rel="noreferrer" target="_blank">{listingText(locale, "source")}</a></p>
        ) : null}
        {isServiceError && onCheckAgain ? (
          <button className="primary-button" onClick={onCheckAgain} type="button">{listingText(locale, "checkAgain")}</button>
        ) : (
          <Link className="primary-button" href={`/${locale}`}>{listingText(locale, "submitAgain")}</Link>
        )}
        <ReportActions locale={locale} listingUrl={safeSource ?? ""} />
      </section>
    </main>
  );
}

function statusCopy(job: ListingJob | null, notice: StatusNotice, locale: Locale) {
  if (notice === "paused") return { title: listingText(locale, "checkingPaused"), description: "" };
  if (notice === "connection") {
    return {
      title: listingText(locale, job ? "connectionInterrupted" : "connectionNotChecked"),
      description: "",
    };
  }
  if (!job) return { title: listingText(locale, "startingCheck"), description: listingText(locale, "startingHelp") };
  if (job.status === "queued") return { title: listingText(locale, "queuedTitle"), description: listingText(locale, "queuedHelp") };
  if (job.status === "running") return { title: listingText(locale, "runningTitle"), description: listingText(locale, "runningHelp") };
  if (job.status === "completed") return { title: listingText(locale, "completeTitle"), description: listingText(locale, "completeHelp") };
  const errorCopy = {
    listing_gone: "listingGone",
    access_blocked: "accessBlocked",
    unsupported_vehicle_type: "unsupportedVehicle",
    parse_failed: "parseFailed",
    temporary_failure: "temporaryFailure",
  } as const;
  return {
    title: listingText(locale, "failedTitle"),
    description: listingText(locale, errorCopy[job.error?.code ?? "parse_failed"]),
  };
}

export function ListingSections({ locale, listing, waiting, warnings }: { locale: Locale; listing: Listing | null; waiting: boolean; warnings: string[] }) {
  const t = (key: Parameters<typeof listingText>[1]) => listingText(locale, key);
  const showWait = listing === null && waiting;
  const unavailable = t("unavailable");
  const facts = listing ? factsFor(listing, locale) : [
    "make", "model", "year", "firstRegistration", "listingPrice", "mileage",
    "fuel", "power", "gearbox", "drivetrain", "bodyType", "colour", "listingId",
  ].map((key) => ({ label: t(key as Parameters<typeof listingText>[1]), value: unavailable }));

  return (
    <div className="listing-content" aria-label={t("listingContent")}>
      <section className="listing-section" aria-labelledby="vehicle-details">
        <h2 id="vehicle-details">{t("vehicleDetails")}</h2>
        <dl className="fact-grid">
          {facts.map((fact) => (
            <div className="fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                {showWait ? (
                  <>
                    <span aria-hidden="true" className="fact-placeholder" />
                    <span className="sr-only">{t("unavailableForNow")}</span>
                  </>
                ) : fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {!listing ? (
        waiting ? (
          <>
            <section className="listing-section"><h2>{t("description")}</h2><span aria-hidden="true" className="fact-placeholder" /></section>
            <section className="listing-section"><h2>{t("equipment")}</h2><span aria-hidden="true" className="fact-placeholder" /></section>
            <section className="listing-section"><h2>{t("technicalDetails")}</h2><span aria-hidden="true" className="fact-placeholder" /></section>
          </>
        ) : null
      ) : (
        <ListingContent locale={locale} listing={listing} />
      )}
      {warnings.length > 0 ? (
        <section className="notice-panel listing-section" aria-labelledby="warnings-heading">
          <h2 id="warnings-heading">{t("warnings")}</h2>
          <ul className="notice-list">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function ListingContent({ locale, listing }: { locale: Locale; listing: Listing }) {
  const t = (key: Parameters<typeof listingText>[1]) => listingText(locale, key);
  const sourceUrl = safeHttpUrl(listing.source_url);
  const photos = listing.photo_urls.flatMap((url) => {
    const safeUrl = safeHttpUrl(url);
    return safeUrl ? [safeUrl] : [];
  });
  const sellerRows = listing.seller ? [
    { label: t("sellerName"), value: listing.seller.name },
    { label: t("sellerType"), value: listing.seller.type },
    { label: t("sellerLocation"), value: listing.seller.location },
  ] : [];

  return (
    <>
      <section className="listing-section" aria-labelledby="seller-description">
        <h2 id="seller-description">{t("description")}</h2>
        <p className="description-copy">{listing.seller_description || t("noDescription")}</p>
      </section>

      {sellerRows.length > 0 ? (
        <section className="listing-section" aria-labelledby="seller-heading">
          <h2 id="seller-heading">{t("seller")}</h2>
          <DetailList rows={sellerRows.map((row) => ({ label: row.label, value: row.value ?? t("unavailable") }))} />
        </section>
      ) : null}

      <section className="listing-section" aria-labelledby="equipment-heading">
        <h2 id="equipment-heading">{t("equipment")}</h2>
        {Object.keys(listing.equipment).length === 0 ? (
          <p className="description-copy">{t("noEquipment")}</p>
        ) : (
          <div className="equipment-list">
            {Object.entries(listing.equipment).map(([category, items]) => (
              <div className="equipment-category" key={category}>
                <h3>{category}</h3>
                {items.length > 0 ? <ul>{items.map((item, index) => <li key={`${category}-${index}`}>{item}</li>)}</ul> : <p className="field-note">{t("unavailable")}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="detail-groups">
        <section className="listing-section" aria-labelledby="technical-details">
          <h2 id="technical-details">{t("technicalDetails")}</h2>
          {Object.keys(listing.technical_specs).length > 0
            ? <DetailList rows={Object.entries(listing.technical_specs).map(([label, value]) => ({ label, value }))} />
            : <p className="description-copy">{t("noTechnicalDetails")}</p>}
        </section>
        <section className="listing-section" aria-labelledby="other-details">
          <h2 id="other-details">{t("otherDetails")}</h2>
          {Object.keys(listing.other_fields).length > 0
            ? <DetailList rows={Object.entries(listing.other_fields).map(([label, value]) => ({ label, value }))} />
            : <p className="description-copy">{t("noOtherDetails")}</p>}
        </section>
      </div>

      <section className="listing-section" aria-labelledby="photos-heading">
        <h2 id="photos-heading">{t("photos")}</h2>
        {photos.length > 0 ? (
          <div className="photo-grid">
            {photos.map((url, index) => (
              <a className="photo-link" href={url} key={url} rel="noreferrer" target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={listingText(locale, "photoAlt", { value: index + 1 })}
                  decoding="async"
                  loading={index === 0 ? "eager" : "lazy"}
                  src={url}
                />
              </a>
            ))}
          </div>
        ) : <p className="description-copy">{t("noPhotos")}</p>}
      </section>

      <section className="listing-section">
        <h2>{t("source")}</h2>
        {sourceUrl ? <a className="source-link" href={sourceUrl} rel="noreferrer" target="_blank">{t("source")}</a> : <p className="description-copy">{t("unavailable")}</p>}
      </section>

      {listing.seller ? null : (
        <section className="listing-section">
          <h2>{t("seller")}</h2>
          <p className="description-copy">{t("noSellerDetails")}</p>
        </section>
      )}


    </>
  );
}

function DetailList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="detail-list">
      {rows.map((row, index) => (
        <div className="detail-row" key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd>{row.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}


export function ListingDashboard({ locale, jobId, submittedSourceUrl }: DashboardProps) {
  const [job, setJob] = useState<ListingJob | null>(null);
  const subscribeSavedUrl = useCallback((listener: () => void) => subscribeListingJobUrl(jobId, listener), [jobId]);
  const getSavedUrl = useCallback(() => readListingJobUrl(jobId), [jobId]);
  const savedUrl = useSyncExternalStore(subscribeSavedUrl, getSavedUrl, getListingJobUrlServerSnapshot);
  const subscribeStartedAt = useCallback((listener: () => void) => subscribePollStartedAt(jobId, listener), [jobId]);
  const getStartedAt = useCallback(() => getPollStartedAtSnapshot(jobId), [jobId]);
  const pollStartedAt = useSyncExternalStore(subscribeStartedAt, getStartedAt, getPollStartedAtServerSnapshot);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<StatusNotice>(null);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [terminalCode, setTerminalCode] = useState<ListingPollTerminalCode | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (pollStartedAt === null) savePollStartedAt(jobId, Date.now());
  }, [jobId, pollStartedAt]);

  useEffect(() => {
    if (pollStartedAt === null || terminalCode !== null || pollingPaused) return;
    const poller = createListingPoller({
      jobId,
      deadlineAt: pollStartedAt + POLL_WINDOW_MS,
      request: getListingJob,
      onJob: (nextJob, checkedAt) => {
        setJob(nextJob);
        setLastSuccessfulAt(checkedAt);
        setNotice(null);
      },
      onUnavailable: () => setNotice("connection"),
      onTerminalError: setTerminalCode,
      onDeadline: () => { setNotice("paused"); setPollingPaused(true); },
    });
    return () => poller.stop();
  }, [jobId, pollStartedAt, pollingPaused, terminalCode]);

  const active = terminalCode === null && !pollingPaused && (!job || job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const status = useMemo(() => statusCopy(job, notice, locale), [job, notice, locale]);
  const listing = job?.status === "completed" ? job.listing : null;
  const sourceUrl = safeHttpUrl(listing?.source_url) ?? safeHttpUrl(job?.source_url) ?? safeHttpUrl(submittedSourceUrl) ?? safeHttpUrl(savedUrl);
  const submittedAt = job ? Date.parse(job.submitted_at) : pollStartedAt ?? now;
  const slow = active && now > 0 && isSlowWait(submittedAt, now);
  const isTerminal = job?.status === "failed" || job?.status === "completed";

  function resumeChecks() {
    const startedAt = Date.now();
    savePollStartedAt(jobId, startedAt);
    setPollingPaused(false);
    setNotice(null);
    setTerminalCode(null);
  }

  if (terminalCode) {
    return (
      <ListingAccessFallback
        locale={locale}
        jobId={jobId}
        code={terminalCode}
        sourceUrl={sourceUrl}
        onCheckAgain={resumeChecks}
      />
    );
  }

  return (
    <main className="page-shell dashboard-page" lang={locale}>
      <SiteHeader locale={locale} languageHrefs={{ et: `/et/a/${encodeURIComponent(jobId)}`, en: `/en/a/${encodeURIComponent(jobId)}` }} showNewListing />
      <div className="dashboard">
        <section
          className="status-panel"
          data-state={notice === "connection" ? "connection" : job?.status ?? "running"}
          aria-label={listingText(locale, "checking")}
        >
          <div className="status-main">
            <span aria-hidden="true" className="status-indicator" data-active={active} />
            <div aria-atomic="true" aria-live="polite" role="status">
              <h2 className="status-title">{status.title}</h2>
              {status.description ? <p className="status-description">{status.description}</p> : null}
            </div>
          </div>
          {!isTerminal && pollStartedAt !== null ? (
            <div aria-live="off" className="status-meta">
              <p>{listingText(locale, "waitingTime", { value: formatElapsed(now - submittedAt, locale) })}</p>
              <p>
                {lastSuccessfulAt === null
                  ? listingText(locale, "noSuccessfulCheck")
                  : listingText(locale, "lastChecked", { value: formatDateTime(lastSuccessfulAt, locale, true) })}
              </p>
            </div>
          ) : null}
          {slow && notice !== "paused" ? <p className="status-slow">{listingText(locale, "takingLonger")}</p> : null}
          {notice === "paused" ? (
            <button className="primary-button status-action" onClick={resumeChecks} type="button">
              {listingText(locale, "checkAgain")}
            </button>
          ) : null}
        </section>

        <div className="dashboard-heading">
          <div>
            <h1>{listing?.title || listingText(locale, "listingTitleFallback")}</h1>
            {job?.parsed_at ? (
              <p title={formatDateTime(job.parsed_at, locale, true)}>
                {listingText(locale, "captured", { value: formatDateTime(job.parsed_at, locale) })}
              </p>
            ) : null}
            {sourceUrl ? <p className="source-address">{sourceUrl}</p> : null}
          </div>
          {sourceUrl ? <a className="source-link" href={sourceUrl} rel="noreferrer" target="_blank">{listingText(locale, "source")}</a> : null}
        </div>

        <ReportActions locale={locale} listingUrl={sourceUrl ?? ""} jobId={job?.status === "completed" ? jobId : undefined} />

        {job?.status === "failed" ? (
          <section className="notice-panel" role="alert">
            <h2>{listingText(locale, "failedTitle")}</h2>
            <p>{status.description}</p>
            <Link className="primary-button" href={`/${locale}`}>{listingText(locale, "tryAnother")}</Link>
          </section>
        ) : (
          <ListingSections locale={locale} listing={listing} waiting={!isTerminal} warnings={job?.warnings ?? []} />
        )}
      </div>
    </main>
  );
}
