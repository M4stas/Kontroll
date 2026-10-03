const AUTO24_HOSTNAME = "auto24.ee";

export function parseHttpsListingUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function isAuto24ListingUrl(url: URL): boolean {
  return url.hostname === AUTO24_HOSTNAME || url.hostname.endsWith(`.${AUTO24_HOSTNAME}`);
}
