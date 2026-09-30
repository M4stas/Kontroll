import type { Locale } from "./messages";

export function formatDateTime(value: number | string, locale: Locale, includeSeconds = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "et" ? "et-EE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: includeSeconds ? "medium" : "short",
  }).format(date);
}
