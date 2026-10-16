import type { JSX } from "react";
import Link from "next/link";
import { PlusIcon } from "@phosphor-icons/react/dist/ssr";
import { listingText, type Locale } from "@/features/listing/messages";

export function SiteHeader({ locale, languageHrefs, showNewListing = false }: {
  locale: Locale;
  languageHrefs: Record<Locale, string>;
  showNewListing?: boolean;
}): JSX.Element {
  return (
    <header className="site-header">
      <Link className="brand" href={`/${locale}`} aria-label={listingText(locale, "brand")}>
        <svg width="22" height="22" aria-hidden="true" viewBox="0 0 24 24">
          <rect x="2" y="2" width="20" height="20" rx="7" fill="var(--accent)" />
          <path d="M7.5 12.4l3 3 6-6.8" stroke="var(--accent-text)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <span className="brand-name">{listingText(locale, "brand")}</span>
      </Link>
      <div className="header-actions">
        {showNewListing && <Link className="new-listing-link" href={`/${locale}`} aria-label={listingText(locale, "newListing")}>
          <span className="new-listing-label">{listingText(locale, "newListing")}</span>
          <PlusIcon className="new-listing-icon" aria-hidden="true" />
        </Link>}
        <nav className="language-switch" aria-label={listingText(locale, "languageLabel")}>
          <Link href={languageHrefs.et} aria-current={locale === "et" ? "page" : undefined}>ET</Link>
          <Link href={languageHrefs.en} aria-current={locale === "en" ? "page" : undefined}>EN</Link>
        </nav>
      </div>
    </header>
  );
}
