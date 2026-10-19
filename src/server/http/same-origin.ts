export function isSameOriginRequest(request: Request): boolean {
  const host = request.headers.get("host");
  let expectedOrigin: string | null = null;

  try {
    if (host && !/[/\\?#@\s,]/.test(host)) {
      expectedOrigin = new URL(`${new URL(request.url).protocol}//${host}`).origin;
    }
  } catch {
    // A malformed request URL or Host header cannot establish a same-origin request.
  }

  return Boolean(
    expectedOrigin &&
      request.headers.get("origin") === expectedOrigin &&
      request.headers.get("sec-fetch-site") !== "cross-site",
  );
}
