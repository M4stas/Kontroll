"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CaptureDiagnosticsSnapshotSchema, type CaptureDiagnosticsSnapshot } from "@/diagnostics/contracts";
import { CaptureTimings } from "./capture-timings";
import { DiagnosticsDrawer } from "./diagnostics-drawer";
import { startPollLoop } from "./poll-loop";

function useCaptureDiagnostics(jobId: string, open: boolean) {
  const [snapshot, setSnapshot] = useState<CaptureDiagnosticsSnapshot | null>(null);
  const [connection, setConnection] = useState<"loading" | "connected" | "offline">("loading");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const retryRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) setConnection("loading");
    });
    const loop = startPollLoop({
      isActive: () => open,
      onFailure: () => setConnection("offline"),
      fetchOnce: async (signal) => {
        const response = await fetch(`/api/listings/${encodeURIComponent(jobId)}/diagnostics`, {
          signal,
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("unavailable");
        const next = CaptureDiagnosticsSnapshotSchema.parse(await response.json());
        if (signal.aborted) return;
        if (next.jobId !== jobId) throw new Error("Unexpected diagnostics owner");
        setSnapshot(next);
        setConnection("connected");
        setLastRefresh(Date.now());
      },
    });
    retryRef.current = loop.retry;
    return () => {
      disposed = true;
      loop.stop();
    };
  }, [jobId, open]);
  return {
    snapshot: snapshot?.jobId === jobId ? snapshot : null,
    connection,
    lastRefresh,
    retry: useCallback(() => retryRef.current(), []),
  };
}

export function ListingDiagnosticsPanel({ jobId, enabled }: { jobId: string; enabled: boolean }) {
  return enabled ? <CaptureDiagnosticsDrawer jobId={jobId} /> : null;
}

function CaptureDiagnosticsDrawer({ jobId }: { jobId: string }) {
  const t = useTranslations("Diagnostics");
  const [open, setOpen] = useState(false);
  const { snapshot, connection, lastRefresh, retry } = useCaptureDiagnostics(jobId, open);
  return (
    <DiagnosticsDrawer title={t("title")} open={open} onOpenChange={setOpen} triggerClassName="secondary-button listing-diagnostics-trigger">
      <p role="status">
        {t(connection)}
        {lastRefresh ? ` · ${t("refreshed", { time: new Date(lastRefresh).toLocaleTimeString() })}` : ""}
      </p>
      {connection === "offline" ? (
        <Button variant="outline" onClick={retry}>
          {t("retry")}
        </Button>
      ) : null}
      {snapshot ? (
        <>
          <p>{t("capture.status", { status: t(`capture.jobStatus.${snapshot.status}`) })}</p>
          <CaptureTimings capture={snapshot.capture} serverNow={snapshot.serverNow} finished={snapshot.status === "completed" || snapshot.status === "failed"} />
        </>
      ) : null}
    </DiagnosticsDrawer>
  );
}
