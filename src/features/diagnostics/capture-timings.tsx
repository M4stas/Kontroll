"use client";
import { useTranslations } from "next-intl";
import { CapturePhaseSchema, type CaptureSpan, type CaptureTimings as CaptureTimingsData } from "@/diagnostics/contracts";
import { duration } from "./review-card";

const PHASES = CapturePhaseSchema.options;
const WAITS = new Set(["queue_wait", "retry_wait"]);

function ordered(spans: CaptureSpan[]) {
  return [...spans].sort(
    (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
}

export function CaptureTimings({ capture, serverNow }: { capture: CaptureTimingsData; serverNow: string }) {
  const t = useTranslations("Diagnostics");
  const attempts = [...new Set(capture.spans.map((span) => span.attempt))].sort((a, b) => a - b);
  const row = (span: CaptureSpan) => {
    const elapsed = span.state === "running" ? Math.max(0, Date.parse(serverNow) - Date.parse(span.startedAt)) : span.durationMs;
    return (
      <li key={span.id} data-phase={span.phase} data-state={span.state}>
        <span>{t(`capture.phase.${span.phase}`)}</span> · {duration(elapsed, t("notRecorded"))} · {t(`capture.state.${span.state}`)}
        {span.errorCode ? ` · ${t(`capture.error.${span.errorCode}`)}` : ""}
      </li>
    );
  };
  return (
    <section className="capture-timings" aria-labelledby="capture-timings-title">
      <h3 id="capture-timings-title">{t("capture.title")}</h3>
      {capture.availability !== "available" ? (
        <p>{t(`capture.availability.${capture.availability}`)}</p>
      ) : !capture.spans.length ? (
        <p>{t("capture.empty")}</p>
      ) : (
        <>
          <p className="text-muted-foreground">{t("capture.note")}</p>
          {attempts.map((attempt) => {
            const spans = ordered(capture.spans.filter((span) => span.attempt === attempt));
            const waits = spans.filter((span) => WAITS.has(span.phase));
            const work = spans.filter((span) => !WAITS.has(span.phase));
            return (
              <div key={attempt} className="diagnostic-card" data-attempt={attempt}>
                <h4>{t("attempt", { number: attempt })}</h4>
                {waits.length ? (
                  <>
                    <p>{t("capture.waits")}</p>
                    <ul>{waits.map(row)}</ul>
                  </>
                ) : null}
                {work.length ? (
                  <>
                    <p>{t("capture.work")}</p>
                    <ul>{work.map(row)}</ul>
                  </>
                ) : null}
              </div>
            );
          })}
        </>
      )}
      {capture.omitted ? <p>{t("omittedTimings", { count: capture.omitted })}</p> : null}
    </section>
  );
}
