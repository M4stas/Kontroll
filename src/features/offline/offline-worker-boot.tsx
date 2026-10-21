"use client";
import { useEffect } from "react";
import { hasLiveSavedReports, listSavedReports } from "./saved-reports-db";
import { ensureWorker, withOfflineLifecycle } from "./worker-client";
export function OfflineWorkerBoot() {
  useEffect(() => {
    let mounted = true;
    void listSavedReports().then(records => {
      if (!mounted || !records.length) return;
      return withOfflineLifecycle(async () => {
        if (mounted && await hasLiveSavedReports()) await ensureWorker();
      });
    }).catch(() => undefined);
    return () => {mounted = false;};
  }, []);
  return null;
}
