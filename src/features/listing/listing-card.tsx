"use client";

import type { CSSProperties, ReactNode } from "react";
import type { Listing } from "@/listings/contracts";
import { formatDateTime } from "./formatters";
import { headlineFigures, keySpecs, openListingDetails } from "./listing-facts";
import { listingText, type Locale } from "./messages";
import type { IdentityField, ListingIdentity } from "./report-gate";

const Pulse = ({ width, height }: { width: string; height: number }) => (
  <span aria-hidden="true" className="pulse" style={{ width, height }} />
);

function IdentityValue({ locale, field, width }: { locale: Locale; field: IdentityField; width: string }) {
  if (field.state === "pending") {
    return <><Pulse width={width} height={16} /><span className="sr-only">{listingText(locale, "identityLoading")}</span></>;
  }
  if (field.state === "not_found") return <span className="identity-missing fade-in">{listingText(locale, "identityNotFound")}</span>;
  return <span className="num fade-in">{field.value}</span>;
}

export function ListingCard({ locale, listing, waiting, sourceUrl, capturedAt, warningCount, identity, children }: {
  locale: Locale;
  listing: Listing | null;
  waiting: boolean;
  sourceUrl: string | null;
  capturedAt: string | null;
  warningCount: number;
  identity: ListingIdentity | null;
  children: ReactNode;
}) {
  const figures = listing ? headlineFigures(listing, locale) : [];
  const specs = listing ? keySpecs(listing, locale) : [];
  return (
    <aside className="listing-card" aria-label={listingText(locale, "vehicleDetails")}>
      <div className="listing-head">
        {listing ? (
          <>
            <h1 className="fade-in">{listing.title || listingText(locale, "listingTitleFallback")}</h1>
            {figures.length > 0 ? <p className="listing-figures num fade-in" style={{ "--delay": "60ms" } as CSSProperties}>{figures.join(" · ")}</p> : null}
            {specs.length > 0 ? <p className="listing-specs fade-in" style={{ "--delay": "90ms" } as CSSProperties}>{specs.join(" · ")}</p> : null}
            <p className="listing-source fade-in" style={{ "--delay": "120ms" } as CSSProperties}>
              {sourceUrl ? <a href={sourceUrl} rel="noreferrer" target="_blank">{listingText(locale, "source")}</a> : null}
              {capturedAt ? <span title={formatDateTime(capturedAt, locale, true)}>{listingText(locale, "captured", { value: formatDateTime(capturedAt, locale) })}</span> : null}
            </p>
            {warningCount > 0 ? (
              <button type="button" className="listing-notes fade-in" onClick={() => openListingDetails("listing-warnings")}>
                {warningCount === 1 ? listingText(locale, "auto24Note") : listingText(locale, "auto24Notes", { value: warningCount })}
              </button>
            ) : null}
          </>
        ) : waiting ? (
          <div className="listing-head-placeholder">
            <Pulse width="85%" height={30} />
            <Pulse width="55%" height={18} />
            {sourceUrl
              ? <p className="listing-source"><a href={sourceUrl} rel="noreferrer" target="_blank">{listingText(locale, "source")}</a></p>
              : <Pulse width="40%" height={14} />}
          </div>
        ) : null}
      </div>
      {identity ? (
        <dl className="listing-identity">
          <div><dt>{listingText(locale, "registration")}</dt><dd><IdentityValue locale={locale} field={identity.registration} width="92px" /></dd></div>
          <div><dt>{listingText(locale, "vin")}</dt><dd><IdentityValue locale={locale} field={identity.vin} width="190px" /></dd></div>
        </dl>
      ) : null}
      {children}
    </aside>
  );
}
