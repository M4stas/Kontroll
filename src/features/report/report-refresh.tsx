"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/domain/analysis";

interface ReportRefreshProps {
  status: AnalysisStatus;
}

export function ReportRefresh({ status }: ReportRefreshProps) {
  const router = useRouter();
  const t = useTranslations("Report");

  useEffect(() => {
    if (status === "complete" || status === "failed") return;

    let hiddenSince = document.hidden ? Date.now() : null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      window.clearInterval(interval);
    };
    const interval = window.setInterval(() => {
      if (document.hidden) {
        hiddenSince ??= Date.now();
        if (Date.now() - hiddenSince > 30_000) stop();
        return;
      }
      if (!stopped) router.refresh();
    }, 3_000);
    const handleVisibility = () => {
      if (document.hidden) {
        hiddenSince ??= Date.now();
      } else if (hiddenSince !== null && Date.now() - hiddenSince > 30_000) {
        stop();
      } else {
        hiddenSince = null;
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [router, status]);

  return (
    <p aria-live="polite" className="sr-only" role="status">
      {t(`status.${status}`)}
    </p>
  );
}
