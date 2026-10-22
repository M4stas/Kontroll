"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/domain/analysis";

interface ReportRefreshProps {
  status: AnalysisStatus;
  backgroundCheckPending?: boolean;
}

export function ReportRefresh({ status, backgroundCheckPending = false }: ReportRefreshProps) {
  const router = useRouter();
  const t = useTranslations("Report");

  useEffect(() => {
    if (!backgroundCheckPending && (status === "complete" || status === "failed")) return;

    let wasHidden = document.hidden;
    let stopped = false;
    let interval: number | undefined;
    const pause = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
    };
    const stop = () => {
      stopped = true;
      pause();
    };
    const resume = () => {
      if (stopped || interval !== undefined) return;
      interval = window.setInterval(() => {
        if (!document.hidden) router.refresh();
      }, 3_000);
    };
    const handleVisibility = () => {
      if (document.hidden) {
        wasHidden = true;
        pause();
      } else if (wasHidden) {
        wasHidden = false;
        router.refresh();
        resume();
      }
    };

    if (!wasHidden) resume();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [router, status, backgroundCheckPending]);

  return (
    <p aria-live="polite" className="sr-only" role="status">
      {t(`status.${status}`)}
    </p>
  );
}
