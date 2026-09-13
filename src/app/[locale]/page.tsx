import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import type { Locale } from "@/domain/analysis";
import { SubmissionForm } from "@/features/submission/submission-form";

interface HomePageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function HomePage({ params }: HomePageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Home");

  return (
    <main className="min-h-[100dvh] px-4 py-5 sm:px-8 sm:py-7">
      <div className="mx-auto max-w-5xl">
        <header className="flex h-10 items-start justify-between border-b border-steel/35">
          <span className="text-sm font-bold tracking-tight">Kontroll</span>
          <nav aria-label="Language" className="flex gap-3 text-xs font-bold">
            <Link
              aria-current={locale === "et" ? "page" : undefined}
              className={locale === "et" ? "text-foreground" : "text-steel"}
              href="/et"
            >
              {t("languageEt")}
            </Link>
            <Link
              aria-current={locale === "en" ? "page" : undefined}
              className={locale === "en" ? "text-foreground" : "text-steel"}
              href="/en"
            >
              {t("languageEn")}
            </Link>
          </nav>
        </header>

        <section className="grid gap-8 py-10 md:grid-cols-12 md:gap-6">
          <div className="md:col-span-8">
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-5xl md:text-6xl">
              {t("headline")}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-steel">{t("intro")}</p>
          </div>

          <div className="md:col-span-10">
            <div className="border-l border-pale-blue/70 bg-blue-gray/55 p-4 sm:p-5">
              <SubmissionForm locale={locale} />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
