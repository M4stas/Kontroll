"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { removeSavedReport, retryOfflinePreparation, saveReport, type SaveResult } from "./save-report";
import { getSavedReport, savedReportsAvailable, subscribeSavedReports, type SavedReportRecord } from "./saved-reports-db";
import { needsIosStorageWarning } from "./ios-storage-warning";

type SaveErrorKey = "accessDenied" | "storageFull" | "unavailable" | "saveFailed" | "removeFailed";
type SaveFailure = Exclude<SaveResult, { status: "saved" | "offline-pending" } | { status: "cancelled" }>;
type Availability = "checking" | "available" | "unavailable";

const saveErrorKey: Record<SaveFailure["status"], SaveErrorKey> = {
  "access-denied": "accessDenied",
  "storage-full": "storageFull",
  unavailable: "unavailable",
  failed: "saveFailed",
};

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function SaveStrip({ report, locale }: { report: AnalysisReport; locale: Locale }) {
  const t = useTranslations("Report.offline");
  const [availability, setAvailability] = useState<Availability>("checking");
  const [saved, setSaved] = useState<SavedReportRecord | null>(null);
  const [error, setError] = useState<SaveErrorKey | null>(null);
  const [busy, setBusy] = useState<"saving" | "removing" | null>(null);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      if (!savedReportsAvailable()) {
        if (mounted) {
          setAvailability("unavailable");
          setError("unavailable");
        }
        return;
      }
      try {
        const record = await getSavedReport(report.publicId);
        if (!mounted) return;
        setSaved(record);
        setAvailability("available");
        setError(null);
      } catch {
        if (!mounted) return;
        setAvailability("unavailable");
        setError("unavailable");
      }
    };

    const unsubscribe = subscribeSavedReports(() => { void refresh(); });
    void refresh();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [report.publicId]);

  if (availability === "checking") return null;

  const newerOnlineVersion = saved !== null && Date.parse(report.updatedAt) > Date.parse(saved.report.updatedAt);

  const save = async () => {
    setError(null);
    setBusy("saving");
    try {
      const result = saved?.offlineReady === false
        ? await retryOfflinePreparation(report.publicId)
        : await saveReport(report.publicId, locale);
      if (result.status === "saved" || result.status === "offline-pending") {
        setSaved(result.record);
      } else if (result.status !== "cancelled") {
        setError(saveErrorKey[result.status]);
        if (result.status === "unavailable") setAvailability("unavailable");
      }
    } catch {
      setError("saveFailed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy("removing");
    try {
      await removeSavedReport(report.publicId);
      setSaved(null);
    } catch {
      setError("removeFailed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="offline-save-strip" aria-label={t("sectionTitle")}>
      <div className="offline-save-copy">
        <p className="offline-save-title">{saved ? t("savedTitle") : t("saveTitle")}</p>
        {saved ? (
          <p className="offline-save-meta">
            {t("savedDates", {
              savedAt: formatDate(saved.savedAt, locale),
              expiresAt: formatDate(saved.expiresAt, locale),
            })}
          </p>
        ) : null}
        {saved?.offlineReady === false ? <p className="offline-save-error" role="status">{t("offlinePending")}</p> : null}
        {newerOnlineVersion ? <p className="offline-save-notice">{t("newer")}</p> : null}
        {error ? <p className="offline-save-error" role="alert">{t(error)}</p> : null}
      </div>
      {availability === "available" ? (
        <div className="offline-save-actions">
          <button className={saved ? "secondary-button" : "primary-button"} type="button" disabled={busy !== null} onClick={() => void save()}>
            {busy === "saving" ? t("saving") : saved?.offlineReady === false ? t("retryOffline") : saved ? t("update") : t("save")}
          </button>
          {saved ? (
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "removing" ? t("removing") : t("remove")}
            </button>
          ) : null}
        </div>
      ) : null}
      {availability === "available" && needsIosStorageWarning() ? (
        <p className="offline-save-warning">{t("iphoneWarning")}</p>
      ) : null}
    </section>
  );
}
