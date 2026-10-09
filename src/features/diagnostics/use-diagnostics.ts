"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiagnosticsSnapshotSchema, type DiagnosticsSnapshot } from "@/diagnostics/contracts";

export function useDiagnostics(publicId: string, open: boolean) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [connection, setConnection] = useState<"loading" | "connected" | "offline">("loading");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [page, setPage] = useState<{ owner: string; runId: string | null; cursor: string | null }>({
    owner: publicId,
    runId: null,
    cursor: null,
  });
  const cursor = page.owner === publicId ? page.cursor : null;
  const retryRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      controller: AbortController | null = null,
      failures = 0;
    queueMicrotask(() => {
      if (!disposed) {
        setConnection("loading");
      }
    });
    const stop = () => {
      clearTimeout(timer);
      controller?.abort();
      controller = null;
    };
    const refresh = async () => {
      clearTimeout(timer);
      if (disposed || !open || document.visibilityState === "hidden" || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch(
          `/api/analyses/${encodeURIComponent(publicId)}/diagnostics${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          {
            signal: request.signal,
            cache: "no-store",
          },
        );
        if (!response.ok) throw new Error("unavailable");
        const next = DiagnosticsSnapshotSchema.parse(await response.json());
        if (disposed || request.signal.aborted) return;
        if (next.owner.publicId !== publicId) throw new Error("Unexpected diagnostics owner");
        if (cursor && page.runId !== next.runId) {
          setPage({ owner: publicId, runId: next.runId, cursor: null });
          return;
        }
        setSnapshot(next);
        setConnection("connected");
        setLastRefresh(Date.now());
        failures = 0;
      } catch {
        if (disposed || request.signal.aborted) return;
        failures++;
        setConnection("offline");
      } finally {
        if (controller === request) controller = null;
        if (!disposed && !request.signal.aborted && open && document.visibilityState === "visible")
          timer = setTimeout(refresh, failures ? [6000, 12000, 30000][Math.min(failures - 1, 2)] : 3000);
      }
    };
    const wake = () => {
      if (document.visibilityState === "hidden") stop();
      else void refresh();
    };
    retryRef.current = () => {
      failures = 0;
      void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    void refresh();
    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [publicId, open, cursor, page.runId]);
  const ownedSnapshot = snapshot?.owner.publicId === publicId ? snapshot : null;
  return {
    snapshot: ownedSnapshot,
    connection,
    lastRefresh,
    cursor,
    retry: useCallback(() => retryRef.current(), []),
    loadOlder: () => {
      if (ownedSnapshot?.nextCursor)
        setPage({ owner: publicId, runId: ownedSnapshot.runId, cursor: ownedSnapshot.nextCursor });
    },
    showRecent: () => setPage({ owner: publicId, runId: null, cursor: null }),
  };
}
