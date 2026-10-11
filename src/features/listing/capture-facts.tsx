import type { ReactNode } from "react";
import type { Listing } from "@/listings/contracts";
import { formatNumber } from "./formatters";
import { listingText, type Locale } from "./messages";

export function factsFor(listing: Listing, locale: Locale): Array<{ label: string; value: string }> {
  const unavailable = listingText(locale, "unavailable");
  const text = (value: string | number | null): string => value === null || value === ""
    ? unavailable
    : typeof value === "number"
      ? formatNumber(value, locale)
      : value;
  const numberWithUnit = (value: number | null, unit: string) => value === null
    ? unavailable
    : `${formatNumber(value, locale)} ${unit}`;
  const price = listing.price?.amount === null || listing.price === null
    ? unavailable
    : `${formatNumber(listing.price.amount, locale)}${listing.price.currency ? ` ${listing.price.currency}` : ""}`;

  return [
    { label: listingText(locale, "make"), value: text(listing.make) },
    { label: listingText(locale, "model"), value: text(listing.model) },
    { label: listingText(locale, "year"), value: listing.year === null ? unavailable : String(listing.year) },
    { label: listingText(locale, "firstRegistration"), value: text(listing.first_registration) },
    { label: listingText(locale, "listingPrice"), value: price },
    { label: listingText(locale, "mileage"), value: numberWithUnit(listing.mileage_km, "km") },
    { label: listingText(locale, "fuel"), value: text(listing.fuel) },
    { label: listingText(locale, "power"), value: numberWithUnit(listing.power_kw, "kW") },
    { label: listingText(locale, "gearbox"), value: text(listing.gearbox) },
    { label: listingText(locale, "drivetrain"), value: text(listing.drivetrain) },
    { label: listingText(locale, "bodyType"), value: text(listing.body_type) },
    { label: listingText(locale, "colour"), value: text(listing.colour) },
    { label: listingText(locale, "listingId"), value: text(listing.listing_id) },
  ];
}

export function CaptureFacts({ locale, listing, waiting, children }: {
  locale: Locale;
  listing: Listing | null;
  waiting: boolean;
  children: ReactNode;
}) {
  const facts = listing ? factsFor(listing, locale) : ([
    "make", "model", "year", "firstRegistration", "listingPrice", "mileage",
    "fuel", "power", "gearbox", "drivetrain", "bodyType", "colour", "listingId",
  ] as const).map((key) => ({ label: listingText(locale, key), value: listingText(locale, "unavailable") }));
  return (
    <aside className="capture-facts" aria-labelledby="vehicle-details">
      <h2 id="vehicle-details">{listingText(locale, "vehicleDetails")}</h2>
      <dl className="facts-list">
        {facts.map(({ label, value }) => (
          <div className="fact" key={label}>
            <dt>{label}</dt>
            <dd>{listing === null && waiting ? (
              <>
                <span aria-hidden="true" className="fact-placeholder" />
                <span className="sr-only">{listingText(locale, "unavailableForNow")}</span>
              </>
            ) : value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </aside>
  );
}
