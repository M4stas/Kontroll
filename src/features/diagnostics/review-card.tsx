"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { EvidenceImage } from "@/features/report/evidence-image";
import type { DiagnosticReview, PhotoSpan } from "@/diagnostics/contracts";
import { DiagnosticsResultSchema, type DiagnosticsResult } from "@/diagnostics/contracts";
type SavedResult = DiagnosticsResult;
export function duration(ms: number | null, unknown: string) {
  if (ms === null) return unknown;
  if (ms > 0 && ms < 1) return "<1 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export function ReviewCard({
  review,
  publicId,
  runId,
  number,
  serverNow,
  provisional,
  cache,
  spans = [],
}: {
  review: DiagnosticReview;
  publicId: string;
  runId: string;
  number: number;
  serverNow: string;
  provisional: boolean;
  cache: Map<string, SavedResult>;
  spans?: PhotoSpan[];
}) {
  const t = useTranslations("Diagnostics");
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<SavedResult | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const identity = `${publicId}:${runId}:${review.executionId}`;
  useEffect(() => {
    if (!expanded || !review.resultAvailable || !review.executionId) return;
    const controller = new AbortController();
    const cached = cache.get(identity);
    if (cached) {
      queueMicrotask(() => {
        if (!controller.signal.aborted) {
          setResult(cached);
          setError(false);
        }
      });
      return () => controller.abort();
    }
    void fetch(
      `/api/analyses/${encodeURIComponent(publicId)}/diagnostics/results?${new URLSearchParams({ runId, executionId: review.executionId })}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return DiagnosticsResultSchema.parse(await response.json());
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.executionId !== review.executionId || value.runId !== runId) throw new Error("outdated");
        if (value.result) cache.set(identity, value);
        setResult(value);
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [expanded, identity, review.resultAvailable, review.executionId, publicId, runId, cache, retry]);
  const latest = review.latestAttempt ?? review.attempts.at(-1);
  const elapsed =
    latest?.state === "started" && review.state === "running"
      ? Math.max(0, Date.parse(serverNow) - Date.parse(latest.startedAt))
      : review.durationMs;
  return (
    <article className="diagnostic-card">
      <h3>{review.pass === "image" ? t("photo", { number }) : t(review.pass)}</h3>
      <p>
        <span className={`diagnostic-state diagnostic-state-${review.state}`}>{t(`state.${review.state}`)}</span> ·{" "}
        {t("attemptDuration")}: {duration(elapsed, t("notRecorded"))}
      </p>
      {review.state === "stale" ? <p>{t("expiredLease")}</p> : null}
      <p className="text-muted-foreground">
        {review.settings
          ? [
              review.settings.provider,
              review.settings.model,
              review.settings.reasoningEffort,
              review.settings.imageDetail,
              review.settings.timeoutMs === null ? null : t("timeout", { seconds: review.settings.timeoutMs / 1000 }),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("notRecorded")}
      </p>
      {review.reusedFrom ? (
        <p>
          {t("reusedFrom", {
            run: review.reusedFrom.runId,
            completed: review.reusedFrom.completedAt ?? t("notRecorded"),
          })}
        </p>
      ) : null}
      {review.attempts.length ? (
        <details>
          <summary>{t("history", { count: review.attempts.length })}</summary>
          <ol>
            {review.attempts.map((attempt) => (
              <li key={attempt.id}>
                {t("attempt", { number: attempt.number })} · {t(`attemptState.${attempt.state}`)} ·{" "}
                {duration(attempt.durationMs, t("notRecorded"))}
                {attempt.warningCode ? ` · ${t(`warning.${attempt.warningCode}`)}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {review.pass === "image" ? (
        <details>
          <summary>{t("photoTimings")}</summary>
          <p className="text-muted-foreground">{t("photoTimingNote")}</p>
          <p>{t("queueRetryUnavailable")}</p>
          {review.reusedFrom ? <p>{t("reusedPreparation")}</p> : null}
          {spans.length ? <TimingSpans spans={spans} /> : <p>{t("notRecorded")}</p>}
          {!spans.some(span => span.phase === "reviewer_prepare") ? <p>{t("reviewerPreparationMissing")}</p> : null}
        </details>
      ) : null}
      {review.resultAvailable ? (
        <button
          type="button"
          className="diagnostic-link"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? "hideResult" : "showResult")}
        </button>
      ) : null}
      {expanded ? (
        <div className="diagnostic-result">
          {review.pass === "image" && review.evidenceId ? (
            <EvidenceImage
              alt={t("photo", { number })}
              src={`/api/analyses/${encodeURIComponent(publicId)}/images/${encodeURIComponent(review.evidenceId)}`}
              width={240}
              height={160}
              className="h-40 w-60 rounded object-cover"
              fallbackClassName="text-muted-foreground"
              unavailableText={t("state.unavailable")}
            />
          ) : null}
          {provisional ? <p className="text-destructive">{t("provisional")}</p> : null}
          {error ? (
            <p role="status">
              {t("resultUnavailable")}{" "}
              <button
                type="button"
                onClick={() => {
                  setError(false);
                  setRetry(retry + 1);
                }}
              >
                {t("retry")}
              </button>
            </p>
          ) : !result?.result ? (
            <p role="status">{t("loading")}</p>
          ) : (
            <>
              {result.result.observations.length === 0 ? (
                <p>{t("zero")}</p>
              ) : (
                result.result.observations.map((observation) => (
                  <section key={observation.id}>
                    <h4>{observation.title}</h4>
                    <p>
                      {t(`severity.${observation.severity}`)} ·{" "}
                      {t("confidence", { value: Math.round(observation.confidence * 100) })}
                    </p>
                    <p>{observation.explanation}</p>
                    <p>{observation.recommendedAction.instructions}</p>
                    <p className="text-muted-foreground">
                      {t("sources")}: {observation.evidenceIds.join(", ") || t("notRecorded")}
                    </p>
                  </section>
                ))
              )}
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function TimingSpans({ spans, parentId = null }: { spans: PhotoSpan[]; parentId?: string | null }) {
  const t = useTranslations("Diagnostics");
  return <ul>{spans.filter(span => span.parentId === parentId).map(span => <li key={span.id}>
    <span>{t(`photoPhase.${span.phase}`)}</span> · {duration(span.durationMs, t("notRecorded"))} · {t(`photoSpanState.${span.state}`)}
    {span.jobAttempt ? ` · ${t("attempt", { number: span.jobAttempt })}` : ""}
    {span.errorCode ? ` · ${t(`photoError.${span.errorCode}`)}` : ""}
    {spans.some(child => child.parentId === span.id) ? <TimingSpans spans={spans} parentId={span.id} /> : null}
  </li>)}</ul>;
}
