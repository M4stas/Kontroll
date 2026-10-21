"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/features/listing/messages";
import { listingText } from "@/features/listing/messages";
import { needsIosStorageWarning } from "./ios-storage-warning";
import { removeSavedReport } from "./save-report";
import { listSavedReports, savedReportsAvailable, subscribeSavedReports, type SavedReportRecord } from "./saved-reports-db";
import { vehicleTitle } from "@/features/report/vehicle-title";

function formatSavedDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "et" ? "et-EE" : "en-GB", { dateStyle: "medium" }).format(date);
}

export function SavedList({ locale }: { locale: Locale }) {
  const [ready, setReady] = useState(false);
  const [reports, setReports] = useState<SavedReportRecord[]>([]);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      if (!savedReportsAvailable()) {
        if (mounted) {
          setReports([]);
          setReady(true);
        }
        return;
      }

      try {
        const saved = await listSavedReports();
        if (!mounted) return;
        setReports(saved);
        setReady(true);
      } catch {
        if (!mounted) return;
        setReports([]);
        setReady(true);
      }
    };

    const unsubscribe = subscribeSavedReports(() => { void refresh(); });
    void refresh();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!ready || reports.length === 0) return null;

  const remove = async (publicId: string) => {
    try {
      await removeSavedReport(publicId);
    } catch {
      // Keep the last known list visible when storage rejects the deletion.
    }
  };

  return (
    <section className="saved-report-list" aria-labelledby="saved-report-list-title">
      <h2 id="saved-report-list-title">{listingText(locale, "savedHeading")}</h2>
      <ul className="saved-report-rows">
        {reports.map((saved) => (
          <li className="saved-report-row" key={saved.publicId}>
            <div className="saved-report-main">
              <div className="saved-report-title">{vehicleTitle(saved.report)}</div>
              <div className="saved-report-meta">
                {listingText(locale, "savedDates", {
                  savedAt: formatSavedDate(saved.savedAt, locale),
                  expiresAt: formatSavedDate(saved.expiresAt, locale),
                })}
              </div>
            </div>
            <div className="saved-report-actions">
              <a className="secondary-button" href={`/${locale}/r/${encodeURIComponent(saved.publicId)}`}>
                {listingText(locale, "savedOpen")}
              </a>
              <button className="saved-report-remove" type="button" onClick={() => { void remove(saved.publicId); }}>
                {listingText(locale, "savedRemove")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {needsIosStorageWarning() ? (
        <p className="saved-report-ios-warning">{listingText(locale, "savedIosWarning")}</p>
      ) : null}
    </section>
  );
}
