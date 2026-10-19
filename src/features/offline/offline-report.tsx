"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/domain/analysis";
import { ReportView } from "@/features/report/report-view";
import { getSavedReport, type SavedReportRecord } from "./saved-reports-db";

export function OfflineReport({ locale, publicId }: { locale: Locale; publicId: string }) {
  const t = useTranslations("Report.offline");
  const [loaded, setLoaded] = useState<{ publicId: string; record: SavedReportRecord | null } | null>(null);

  useEffect(() => {
    let active = true;
    void getSavedReport(publicId).catch(() => null).then(record => {
      if (active) setLoaded({ publicId, record });
    });
    return () => { active = false; };
  }, [publicId]);

  if (loaded?.publicId !== publicId) return <p role="status">{t("loading")}</p>;
  if (!loaded.record) return <section className="access-panel" role="status">
    <p>{t("noCopy")}</p>
    <Link href={`/${locale}`}>{t("goHome")}</Link>
  </section>;

  const savedAt = new Intl.DateTimeFormat(locale === "et" ? "et-EE" : "en-GB", { dateStyle: "medium" }).format(new Date(loaded.record.savedAt));
  return <>
    <p role="status">{t("savedWarning", { date: savedAt })}</p>
    <ReportView locale={locale} report={loaded.record.report} offline />
  </>;
}
