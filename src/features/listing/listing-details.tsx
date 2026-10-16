import type { CSSProperties } from "react";
import type { Listing } from "@/listings/contracts";
import { formatDateTime, safeHttpUrl } from "./formatters";
import { factsFor } from "./listing-facts";
import { listingText, type Locale } from "./messages";

function DetailList({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="detail-list">
      {rows.map((row, index) => (
        <div className="detail-row" key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd>{row.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

// Everything the card does not show. Closed until the user opens it.
export function ListingDetails({ locale, listing, sourceUrl, capturedAt, warnings }: {
  locale: Locale;
  listing: Listing;
  sourceUrl: string | null;
  capturedAt: string | null;
  warnings: string[];
}) {
  const t = (key: Parameters<typeof listingText>[1]) => listingText(locale, key);
  const photos = listing.photo_urls.flatMap((url) => {
    const safeUrl = safeHttpUrl(url);
    return safeUrl ? [safeUrl] : [];
  });
  const sellerRows = listing.seller ? [
    { label: t("sellerName"), value: listing.seller.name ?? t("unavailable") },
    { label: t("sellerType"), value: listing.seller.type ?? t("unavailable") },
    { label: t("sellerLocation"), value: listing.seller.location ?? t("unavailable") },
  ] : [];

  return (
    <details className="listing-details fade-in" id="listing-details" style={{ "--delay": "160ms" } as CSSProperties}>
      <summary>{t("allDetails")}</summary>
      <div className="listing-details-body" aria-label={t("listingContent")}>
        {warnings.length > 0 ? (
          <section className="listing-section listing-warnings" id="listing-warnings" aria-labelledby="warnings-heading">
            <h2 id="warnings-heading">{t("warnings")}</h2>
            <ul className="notice-list">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </section>
        ) : null}

        <section className="listing-section" id="all-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading">{t("photos")}</h2>
          {photos.length > 0 ? (
            <div className="listing-photo-grid">
              {photos.map((url, index) => (
                <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={listingText(locale, "photoAlt", { value: index + 1 })} decoding="async" loading="lazy" />
                </a>
              ))}
            </div>
          ) : <p className="description-copy">{t("noPhotos")}</p>}
        </section>

        <div className="detail-groups">
          <section className="listing-section" aria-labelledby="vehicle-details-heading">
            <h2 id="vehicle-details-heading">{t("vehicleDetails")}</h2>
            <DetailList rows={factsFor(listing, locale)} />
          </section>
          <section className="listing-section" aria-labelledby="seller-heading">
            <h2 id="seller-heading">{t("seller")}</h2>
            {sellerRows.length > 0 ? <DetailList rows={sellerRows} /> : <p className="description-copy">{t("noSellerDetails")}</p>}
          </section>
        </div>

        <section className="listing-section" aria-labelledby="seller-description">
          <h2 id="seller-description">{t("description")}</h2>
          <p className="description-copy">{listing.seller_description || t("noDescription")}</p>
        </section>

        <section className="listing-section" aria-labelledby="equipment-heading">
          <h2 id="equipment-heading">{t("equipment")}</h2>
          {Object.keys(listing.equipment).length === 0 ? (
            <p className="description-copy">{t("noEquipment")}</p>
          ) : (
            <div className="equipment-list">
              {Object.entries(listing.equipment).map(([category, items]) => (
                <div className="equipment-category" key={category}>
                  <h3>{category}</h3>
                  {items.length > 0 ? <ul>{items.map((item, index) => <li key={`${category}-${index}`}>{item}</li>)}</ul> : <p className="field-note">{t("unavailable")}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="detail-groups">
          <section className="listing-section" aria-labelledby="technical-details">
            <h2 id="technical-details">{t("technicalDetails")}</h2>
            {Object.keys(listing.technical_specs).length > 0
              ? <DetailList rows={Object.entries(listing.technical_specs).map(([label, value]) => ({ label, value }))} />
              : <p className="description-copy">{t("noTechnicalDetails")}</p>}
          </section>
          <section className="listing-section" aria-labelledby="other-details">
            <h2 id="other-details">{t("otherDetails")}</h2>
            {Object.keys(listing.other_fields).length > 0
              ? <DetailList rows={Object.entries(listing.other_fields).map(([label, value]) => ({ label, value }))} />
              : <p className="description-copy">{t("noOtherDetails")}</p>}
          </section>
        </div>

        <section className="listing-section">
          <h2>{t("source")}</h2>
          {sourceUrl ? <a className="source-link" href={sourceUrl} rel="noreferrer" target="_blank">{sourceUrl}</a> : <p className="description-copy">{t("unavailable")}</p>}
          {capturedAt ? <p className="field-note">{listingText(locale, "captured", { value: formatDateTime(capturedAt, locale, true) })}</p> : null}
        </section>
      </div>
    </details>
  );
}
