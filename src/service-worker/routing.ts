export type Route =
  | { kind: "front"; locale: "et" | "en" }
  | { kind: "report"; locale: "et" | "en"; publicId: string }
  | { kind: "static" }
  | { kind: "pass" };
export const SHELL_HEADER = "x-kontroll-offline-shell";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function routeRequest(url: URL, origin: string, mode: RequestMode, method: string): Route {
  if (url.origin !== origin || method !== "GET") return {kind: "pass"};
  if (url.pathname.startsWith("/_next/static/")) return {kind: "static"};
  if (mode !== "navigate") return {kind: "pass"};
  if (url.pathname === "/" || url.pathname === "/et") return {kind: "front", locale: "et"};
  if (url.pathname === "/en") return {kind: "front", locale: "en"};
  const match = /^\/(et|en)\/r\/([^/]+)$/.exec(url.pathname);
  if (match && uuid.test(match[2]!)) return {kind: "report", locale: match[1] as "et" | "en", publicId: match[2]!};
  return {kind: "pass"};
}
export function staticAssetsIn(html: string): string[] {
  const assets = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["'](\/_next\/static\/[^"']+)["']/gi)) {
    const path = match[1]!.split(/[?#]/)[0]!;
    // URL normalization must not turn an apparent asset into an API or page URL.
    if (new URL(path, "https://assets.test").pathname.startsWith("/_next/static/")) assets.add(path);
  }
  return [...assets];
}
export function shellPaths(publicId: string): [string, string] { return [`/et/r/${publicId}`, `/en/r/${publicId}`]; }
export function cacheName(buildVersion: string): string { return `kontroll-offline-${buildVersion}`; }
