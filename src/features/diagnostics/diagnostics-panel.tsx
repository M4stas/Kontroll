"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDiagnostics } from "./use-diagnostics";
import { ReviewCard } from "./review-card";
export function DiagnosticsPanel({ publicId, enabled }: { publicId: string; enabled: boolean }) {
  const t = useTranslations("Diagnostics");
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [cache] = useState(() => new Map());
  const { snapshot, connection, lastRefresh, retry, cursor, loadOlder, showRecent } = useDiagnostics(
    publicId,
    enabled && open,
  );
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const photos = snapshot?.reviews.filter((review) => review.pass === "image") ?? [];
  const finalComplete = snapshot?.reviews.some(
    (review) => review.pass === "final" && ["complete", "reused"].includes(review.state),
  );
  if (!enabled) return null;
  return (
    <>
      <Button ref={trigger} className="my-4" variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {t("title")}
      </Button>
      <dialog
        ref={dialog}
        className="diagnostics-drawer"
        aria-labelledby="diagnostics-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={close}
      >
        <header className="diagnostics-header">
          <h2 id="diagnostics-title">{t("title")}</h2>
          <Button variant="ghost" onClick={close} aria-label={t("close")}>
            ×
          </Button>
        </header>
        <div className="diagnostics-body">
          <p role="status">
            {t(connection)}
            {lastRefresh ? ` · ${t("refreshed", { time: new Date(lastRefresh).toLocaleTimeString() })}` : ""}
          </p>
          {connection === "offline" ? (
            <Button variant="outline" onClick={retry}>
              {t("retry")}
            </Button>
          ) : null}
          <p className="text-muted-foreground">{t("timingNote")}</p>
          {snapshot ? (
            <>
              <p className="diagnostics-counts">
                {t("counts", {
                  selected: photos.filter((p) => p.selected).length,
                  complete: photos.filter((p) => ["complete", "reused"].includes(p.state)).length,
                  running: photos.filter((p) => p.state === "running").length,
                  waiting: photos.filter((p) => ["waiting", "retrying"].includes(p.state)).length,
                  unavailable: photos.filter((p) => p.state === "unavailable").length,
                  skipped: photos.filter((p) => p.state === "skipped").length,
                })}
              </p>
              {snapshot.availability.review === "not_recorded" ? <p>{t("notRecorded")}</p> : null}
              {snapshot.runId ? (
                <p className="text-muted-foreground diagnostic-run">
                  {t("run")}: {snapshot.runId}
                </p>
              ) : null}
              {snapshot.stages.length ? (
                <details>
                  <summary>{t("stages")}</summary>
                  <ul>
                    {snapshot.stages.map((stage) => (
                      <li key={stage.id}>
                        {t(`stage.${stage.stage}`)} · {t(`stageState.${stage.state}`)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p>
                {t("internalTimings")}: {t(`timingAvailability.${snapshot.availability.internalTimings}`)}
              </p>
              {snapshot.availability.omittedSpans ? <p>{t("omittedTimings", { count: snapshot.availability.omittedSpans })}</p> : null}
              {snapshot.reviews.map((review) => (
                <ReviewCard
                  key={`${snapshot.runId}:${review.key}:${review.executionId}`}
                  review={review}
                  spans={snapshot.spans.filter(span => span.evidenceId === review.evidenceId)}
                  publicId={publicId}
                  runId={snapshot.runId!}
                  number={photos.findIndex((photo) => photo.key === review.key) + 1}
                  serverNow={snapshot.serverNow}
                  provisional={!finalComplete}
                  cache={cache}
                />
              ))}
              {cursor ? (
                <Button variant="outline" onClick={showRecent}>
                  {t("recentAttempts")}
                </Button>
              ) : null}
              {snapshot.nextCursor ? (
                <Button variant="outline" onClick={loadOlder}>
                  {t("olderAttempts")}
                </Button>
              ) : null}
              {snapshot.truncated ? <p>{t("truncated")}</p> : null}
            </>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
