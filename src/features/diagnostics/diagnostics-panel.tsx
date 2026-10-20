"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDiagnostics } from "./use-diagnostics";
import { ReviewCard } from "./review-card";
import { CaptureTimings } from "./capture-timings";
import { DiagnosticsDrawer } from "./diagnostics-drawer";
export function DiagnosticsPanel({ publicId, enabled }: { publicId: string; enabled: boolean }) {
  const t = useTranslations("Diagnostics");
  const [open, setOpen] = useState(false);
  const [cache] = useState(() => new Map());
  const { snapshot, connection, lastRefresh, retry, cursor, loadOlder, showRecent } = useDiagnostics(
    publicId,
    enabled && open,
  );
  const photos = snapshot?.reviews.filter((review) => review.pass === "image") ?? [];
  const finalComplete = snapshot?.reviews.some(
    (review) => review.pass === "final" && ["complete", "reused"].includes(review.state),
  );
  if (!enabled) return null;
  return (
    <DiagnosticsDrawer title={t("title")} open={open} onOpenChange={setOpen}>
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
          {snapshot.capture ? <CaptureTimings capture={snapshot.capture} serverNow={snapshot.serverNow} /> : null}
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
    </DiagnosticsDrawer>
  );
}
