"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiagnosticsSnapshotSchema, type DiagnosticsSnapshot } from "@/diagnostics/contracts";
import { startPollLoop } from "./poll-loop";

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
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) {
        setConnection("loading");
      }
    });
    const loop = startPollLoop({
      isActive: () => open,
      onFailure: () => setConnection("offline"),
      fetchOnce: async (signal) => {
        const response = await fetch(
          `/api/analyses/${encodeURIComponent(publicId)}/diagnostics${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          {
            signal,
            cache: "no-store",
          },
        );
        if (!response.ok) throw new Error("unavailable");
        const next = DiagnosticsSnapshotSchema.parse(await response.json());
        if (signal.aborted) return;
        if (next.owner.publicId !== publicId) throw new Error("Unexpected diagnostics owner");
        if (cursor && page.runId !== next.runId) {
          setPage({ owner: publicId, runId: next.runId, cursor: null });
          return;
        }
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
