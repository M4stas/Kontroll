import type { Locale } from "./messages";

export function formatDateTime(value: number | string, locale: Locale, includeSeconds = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "et" ? "et-EE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: includeSeconds ? "medium" : "short",
  }).format(date);
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "et" ? "et-EE" : "en-GB").format(value);
}
