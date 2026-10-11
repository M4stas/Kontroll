import type { JSX } from "react";
import Link from "next/link";
import { listingText, type Locale } from "@/features/listing/messages";

export function SiteHeader({ locale, languageHrefs, showNewListing = false }: {
  locale: Locale;
  languageHrefs: Record<Locale, string>;
  showNewListing?: boolean;
}): JSX.Element {
  return (
    <header className="site-header">
      <Link className="brand" href={`/${locale}`}>
        <svg width="22" height="22" aria-hidden="true" viewBox="0 0 24 24">
          <rect x="2" y="2" width="20" height="20" rx="7" fill="var(--accent)" />
          <path d="M7.5 12.4l3 3 6-6.8" stroke="var(--accent-text)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        {listingText(locale, "brand")}
      </Link>
      <div className="header-actions">
        {showNewListing && <Link className="new-listing-link" href={`/${locale}`}>{listingText(locale, "newListing")}</Link>}
        <nav className="language-switch" aria-label={listingText(locale, "languageLabel")}>
          <Link href={languageHrefs.et} aria-current={locale === "et" ? "page" : undefined}>ET</Link>
          <Link href={languageHrefs.en} aria-current={locale === "en" ? "page" : undefined}>EN</Link>
        </nav>
      </div>
    </header>
  );
}
