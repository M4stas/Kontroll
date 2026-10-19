"use client";

import { useOnline } from "@/features/offline/use-online";
import { ReportActions } from "@/features/submission/report-actions";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { canonicalListingUrl, jobIdSchema } from "@/listings/contracts";
import { listingText, type Locale } from "./messages";
import {
  getListingDraftServerSnapshot,
  getListingDraftSnapshot,
  saveListingDraft,
  saveListingJob,
  subscribeListingDraft,
} from "./session-storage";
import { createListingSubmitter, ListingSubmissionTimeoutError } from "./submission";

interface SubmissionFormProps {
  locale: Locale;
}

function apiErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = body.error;
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function submissionError(locale: Locale, code: string | null): string {
  switch (code) {
    case "invalid_url":
      return listingText(locale, "invalidUrl");
    case "invalid_request":
      return listingText(locale, "requestInvalid");
    case "forbidden":
      return listingText(locale, "requestForbidden");
    case "configuration_error":
    case "service_auth_error":
      return listingText(locale, "serviceConfig");
    case "service_unavailable":
      return listingText(locale, "serviceUnavailable");
    case "invalid_service_response":
      return listingText(locale, "serviceResponseInvalid");
    default:
      return listingText(locale, "submitFailed");
  }
}

export function SubmissionForm({ locale }: SubmissionFormProps) {
  const online = useOnline();
  const [networkFailed, setNetworkFailed] = useState(false);
  useEffect(() => {
    const restore = () => setNetworkFailed(false);
    window.addEventListener("online", restore);
    return () => window.removeEventListener("online", restore);
  }, []);
  const offline = !online || networkFailed;
  const listingUrl = useSyncExternalStore(
    subscribeListingDraft,
    getListingDraftSnapshot,
    getListingDraftServerSnapshot,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingSubmission = useRef(false);
  const submitter = useRef<ReturnType<typeof createListingSubmitter> | null>(null);
  const router = useRouter();
  if (submitter.current === null) submitter.current = createListingSubmitter();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline) return;
    setError(null);

    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalListingUrl(listingUrl.trim());
    } catch {
      setError(listingText(locale, "invalidUrl"));
      return;
    }

    if (pendingSubmission.current) return;
    pendingSubmission.current = true;
    saveListingDraft(canonicalUrl);
    setPending(true);
    let navigating = false;
    try {
      const { response, body } = await submitter.current!(canonicalUrl);
      if (!response.ok || !body || typeof body !== "object" || !("jobId" in body)) {
        setError(submissionError(locale, apiErrorCode(body)));
        return;
      }
      const parsedJobId = jobIdSchema.safeParse(body.jobId);
      if (!parsedJobId.success) {
        setError(listingText(locale, "serviceResponseInvalid"));
        return;
      }

      const pollStartedAt = Date.now();
      saveListingDraft(canonicalUrl);
      saveListingJob(parsedJobId.data, canonicalUrl, pollStartedAt);
      router.push(`/${locale}/a/${encodeURIComponent(parsedJobId.data)}`);
      navigating = true;
    } catch (submitError) {
      if (submitError instanceof TypeError) setNetworkFailed(true);
      setError(listingText(locale, submitError instanceof ListingSubmissionTimeoutError ? "submitTimedOut" : "submitUncertain"));
    } finally {
      if (!navigating) {
        pendingSubmission.current = false;
        setPending(false);
      }
    }
  }

  return (
    <>
    {offline ? <p className="offline-notice" role="status">{listingText(locale, "offlineNotice")}</p> : null}
    {networkFailed && online ? <button className="secondary-button" type="button" onClick={() => { setNetworkFailed(false); setError(null); }}>{listingText(locale, "retryConnection")}</button> : null}
    <div inert={offline} aria-disabled={offline} className={offline ? "offline-form" : undefined}>
    {/* The offline state is explicit for assistive technology as well as inert. */}
    {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
    <form inert={offline} aria-disabled={offline} className="listing-form" noValidate onSubmit={handleSubmit}>
      <label className="field-label" htmlFor="listing-url">{listingText(locale, "listingUrl")}</label>
      <div className="url-bar">
        <input
          autoComplete="url"
          aria-describedby={error ? "listing-url-note listing-url-error" : "listing-url-note"}
          aria-invalid={error !== null}
          className="url-input"
          id="listing-url"
          name="listingUrl"
          onChange={(event) => {
            saveListingDraft(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder={listingText(locale, "listingUrlPlaceholder")}
          required
          type="url"
          value={listingUrl}
        />
        <button className="primary-button" disabled={pending} type="submit">
          {pending ? listingText(locale, "sendingListing") : listingText(locale, "sendListing")}
        </button>
      </div>
      <p className="field-note" id="listing-url-note">{listingText(locale, "homeNote")}</p>
      {error ? <p className="form-error" id="listing-url-error" role="alert">{error}</p> : null}
      {pending ? (
        <p aria-live="polite" className="pending-line" role="status">
          <span aria-hidden="true" className="activity-dot" />
          {listingText(locale, "sendingListing")}
        </p>
      ) : null}
    </form>
    <ReportActions locale={locale} listingUrl={listingUrl} />
    </div>
    </>
  );
}
