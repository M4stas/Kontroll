import type { Listing } from "@/listings/contracts";
import { formatNumber } from "./formatters";
import { listingText, type Locale } from "./messages";

export function priceText(listing: Listing, locale: Locale): string | null {
  if (listing.price === null || listing.price.amount === null) return null;
  return `${formatNumber(listing.price.amount, locale)}${listing.price.currency ? ` ${listing.price.currency}` : ""}`;
}

const present = (values: Array<string | null | undefined>) => values.filter((value): value is string => !!value);

// Price, mileage and year for the card head. Missing values are left out.
export function headlineFigures(listing: Listing, locale: Locale): string[] {
  return present([
    priceText(listing, locale),
    listing.mileage_km === null ? null : `${formatNumber(listing.mileage_km, locale)} km`,
    listing.year === null ? null : String(listing.year),
  ]);
}

// Fuel, gearbox, power and body type for the line under the figures.
export function keySpecs(listing: Listing, locale: Locale): string[] {
  return present([
    listing.fuel,
    listing.gearbox,
    listing.power_kw === null ? null : `${formatNumber(listing.power_kw, locale)} kW`,
    listing.body_type,
  ]);
}

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

  return [
    { label: listingText(locale, "make"), value: text(listing.make) },
    { label: listingText(locale, "model"), value: text(listing.model) },
    { label: listingText(locale, "year"), value: listing.year === null ? unavailable : String(listing.year) },
    { label: listingText(locale, "firstRegistration"), value: text(listing.first_registration) },
    { label: listingText(locale, "listingPrice"), value: priceText(listing, locale) ?? unavailable },
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

// Opens the closed details section and scrolls to one of its groups.
export function openListingDetails(targetId = "listing-details") {
  const details = document.getElementById("listing-details");
  if (details instanceof HTMLDetailsElement) details.open = true;
  document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
