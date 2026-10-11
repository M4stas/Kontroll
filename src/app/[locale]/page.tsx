import { SiteHeader } from "@/components/site-header";
import { listingText, type Locale } from "@/features/listing/messages";
import { SubmissionForm } from "@/features/listing/submission-form";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "et" && locale !== "en") return null;
  const language: Locale = locale;

  return (
    <main className="page-shell home-page" lang={language}>
      <SiteHeader locale={language} languageHrefs={{ et: "/et", en: "/en" }} />

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
