import { cookies, headers } from "next/headers";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { AnalysisReport, Locale } from "@/domain/analysis";
import { AccessBootstrap } from "@/features/report/access-bootstrap";
import { loadReport, ReportAccessError } from "@/features/report/load-report";
import { OfflineReport } from "@/features/offline/offline-report";
import { analysisAccessCookieName } from "@/server/access/analysis-access";

interface ReportPageProps {
  params: Promise<{ locale: Locale; publicId: string }>;
}

export default async function ReportPage({ params }: ReportPageProps) {
  const { locale, publicId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Report");
  const shellOnly = (await headers()).get("x-kontroll-offline-shell") === "1";
  const cookie = (await cookies()).get(analysisAccessCookieName(publicId))?.value;
  let report: AnalysisReport | null = null;

  if (cookie) {
    try {
      report = await loadReport({ publicId, cookie });
    } catch (error) {
      if (!(error instanceof ReportAccessError)) throw error;
    }
  }

  return (
    <main className="min-h-[100dvh] px-4 py-5 sm:px-8 sm:py-7" data-report-shell={report ? "true" : undefined}>
      <AccessBootstrap publicId={publicId} />
      <div className="mx-auto max-w-6xl">
        <header className="flex min-h-11 items-center justify-between border-b border-steel/35">
          <Link className="inline-flex min-h-11 items-center text-sm font-bold tracking-tight" href={`/${locale}`}>Kontroll</Link>
          <nav aria-label={t("languageLabel")} className="flex gap-1 text-xs font-bold">
            <Link
              aria-current={locale === "et" ? "page" : undefined}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center ${locale === "et" ? "text-foreground" : "text-steel"}`}
              href={`/et/a/${publicId}`}
            >
              {t("languageEt")}
            </Link>
            <Link
              aria-current={locale === "en" ? "page" : undefined}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center ${locale === "en" ? "text-foreground" : "text-steel"}`}
              href={`/en/a/${publicId}`}
            >
              {t("languageEn")}
            </Link>
          </nav>
        </header>

        <OfflineReport locale={locale} publicId={publicId} serverReport={shellOnly ? null : report} accessFallback={
          <section className="max-w-2xl py-16" role="status">
            <p className="text-sm font-semibold text-pale-blue">{t("access.status")}</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em]">{t("access.heading")}</h1>
            <p className="mt-4 text-base leading-7 text-steel">{t("access.explanation")}</p>
          </section>
        } />
      </div>
    </main>
  );
}
