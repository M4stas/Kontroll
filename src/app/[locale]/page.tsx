import Link from "next/link";
import { listingText, type Locale } from "@/features/listing/messages";
import { SubmissionForm } from "@/features/listing/submission-form";

function LanguageLinks({ locale }: { locale: Locale }) {
  return (
    <nav aria-label={listingText(locale, "languageLabel")} className="language-switch">
      <Link aria-current={locale === "et" ? "page" : undefined} href="/et">ET</Link>
      <Link aria-current={locale === "en" ? "page" : undefined} href="/en">EN</Link>
    </nav>
  );
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "et" && locale !== "en") return null;
  const language: Locale = locale;

  return (
    <main className="page-shell home-page" lang={language}>
      <header className="site-header">
        <Link className="brand" href={`/${language}`}>{listingText(language, "brand")}</Link>
        <LanguageLinks locale={language} />
      </header>

      <section className="home-content">
        <h1>{listingText(language, "homeTitle")}</h1>
        <p className="lead-copy">{listingText(language, "homeIntro")}</p>
        <div className="submission-panel">
          <SubmissionForm locale={language} />
        </div>
      </section>
    </main>
  );
}
