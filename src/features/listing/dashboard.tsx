"use client";

import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ReportActions } from "@/features/submission/report-actions";
import { ListingDiagnosticsPanel } from "@/features/diagnostics/listing-diagnostics-panel";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  jobErrorCodeSchema,
  jobIdSchema,
  listingSchema,
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
import { formatDateTime, safeHttpUrl } from "./formatters";
import { ListingCard } from "./listing-card";
import { ListingDetails } from "./listing-details";
import { ListingGallery } from "./listing-gallery";
import { reportGate } from "./report-gate";
import { identitySettled, listingIdentity } from "./identity";
import {
  getListingJobUrlServerSnapshot,
  getPollStartedAtServerSnapshot,
  readListingJobUrl,
  readPollStartedAt,
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
  diagnosticsEnabled?: boolean;
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

function formatElapsed(milliseconds: number, locale: Locale): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return listingText(locale, "seconds", { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return listingText(locale, "minutesSeconds", { minutes, seconds: seconds % 60 });
  return listingText(locale, "hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
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

export function ListingDashboard({ locale, jobId, submittedSourceUrl, diagnosticsEnabled = false }: DashboardProps) {
  const [job, setJob] = useState<ListingJob | null>(null);
  const [revealExpired, setRevealExpired] = useState(false);
  const subscribeSavedUrl = useCallback((listener: () => void) => subscribeListingJobUrl(jobId, listener), [jobId]);
  const getSavedUrl = useCallback(() => readListingJobUrl(jobId), [jobId]);
  const savedUrl = useSyncExternalStore(subscribeSavedUrl, getSavedUrl, getListingJobUrlServerSnapshot);
  const subscribeStartedAt = useCallback((listener: () => void) => subscribePollStartedAt(jobId, listener), [jobId]);
  const getStartedAt = useCallback(() => readPollStartedAt(jobId), [jobId]);
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
      onRevealExpired: () => { setRevealExpired(true); setNotice(null); },
      onUnavailable: () => setNotice("connection"),
      onTerminalError: setTerminalCode,
      onDeadline: () => { setNotice("paused"); setPollingPaused(true); },
    });
    return () => poller.stop();
  }, [jobId, pollStartedAt, pollingPaused, terminalCode]);

  const isTerminal = job?.status === "failed" || (job?.status === "completed" && (identitySettled(job) || revealExpired));
  const active = terminalCode === null && !pollingPaused && !isTerminal;
  const identity = listingIdentity(job, revealExpired);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const status = useMemo(() => statusCopy(job, notice, locale), [job, notice, locale]);
  const listing = job?.status === "completed" ? job.listing : null;
  const sourceUrl = safeHttpUrl(listing?.source_url) ?? safeHttpUrl(job?.source_url) ?? safeHttpUrl(submittedSourceUrl) ?? safeHttpUrl(savedUrl);
  const submittedAt = job ? Date.parse(job.submitted_at) : pollStartedAt ?? now;
  // The identity reveal has its own deadline, so only extraction can be slow.
  const slow = active && job?.status !== "completed" && now > 0 && isSlowWait(submittedAt, now);

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

  const gate = reportGate(job?.status ?? null, identity);
  const statusLine = (
    <div className="listing-status" data-state={notice ?? job?.status ?? "running"}>
      <p>
        <span aria-atomic="true" aria-live="polite" role="status">
          {gate.reason === "waitingForIdentity" ? listingText(locale, "waitingForIdentity") : status.title}
        </span>
        {!isTerminal && pollStartedAt !== null && notice === null ? (
          <span
            className="num"
            aria-hidden="true"
            title={lastSuccessfulAt === null
              ? listingText(locale, "noSuccessfulCheck")
              : listingText(locale, "lastChecked", { value: formatDateTime(lastSuccessfulAt, locale, true) })}
          >
            {" · "}{formatElapsed(now - submittedAt, locale)}
          </span>
        ) : null}
      </p>
      {isTerminal && gate.enabled ? <p className="listing-status-help">{status.description}</p> : null}
      {slow && notice !== "paused" ? <p className="listing-status-help">{listingText(locale, "takingLonger")}</p> : null}
      {!isTerminal && pollStartedAt !== null ? (
        <p className="sr-only">
          {lastSuccessfulAt === null
            ? listingText(locale, "noSuccessfulCheck")
            : listingText(locale, "lastChecked", { value: formatDateTime(lastSuccessfulAt, locale, true) })}
        </p>
      ) : null}
      {notice === "paused" ? (
        <button className="text-button" onClick={resumeChecks} type="button">{listingText(locale, "checkAgain")}</button>
      ) : null}
    </div>
  );

  return (
    <main className="page-shell dashboard-page" lang={locale}>
      <SiteHeader locale={locale} languageHrefs={{ et: `/et/a/${encodeURIComponent(jobId)}`, en: `/en/a/${encodeURIComponent(jobId)}` }} showNewListing />
      {job?.status === "failed" ? (
        <section className="listing-failed" role="alert">
          <p className="listing-failed-title">{listingText(locale, "failedTitle")}</p>
          <p>{status.description}</p>
          {sourceUrl ? <p className="listing-failed-source">{sourceUrl}</p> : null}
          <Link className="primary-button" href={`/${locale}`}>{listingText(locale, "tryAnother")}</Link>
          <ReportActions locale={locale} listingUrl={sourceUrl ?? ""} />
          <ListingDiagnosticsPanel jobId={jobId} enabled={diagnosticsEnabled} />
        </section>
      ) : (
        <>
          <div className="listing-layout">
            <ListingGallery locale={locale} photoUrls={listing ? listing.photo_urls : null} />
            <ListingCard
              locale={locale}
              listing={listing}
              waiting={!isTerminal}
              sourceUrl={sourceUrl}
              capturedAt={job?.parsed_at ?? null}
              warningCount={job?.warnings.length ?? 0}
              identity={identity}
            >
              <ReportActions locale={locale} listingUrl={sourceUrl ?? ""} jobId={jobId} disabled={!gate.enabled} note={statusLine} phoneBottomBar />
              <ListingDiagnosticsPanel jobId={jobId} enabled={diagnosticsEnabled} />
            </ListingCard>
          </div>
          {listing ? (
            <ListingDetails locale={locale} listing={listing} sourceUrl={sourceUrl} capturedAt={job?.parsed_at ?? null} warnings={job?.warnings ?? []} />
          ) : null}
        </>
      )}
    </main>
  );
}
