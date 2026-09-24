/// <reference lib="webworker" />

const worker = self as unknown as ServiceWorkerGlobalScope;
const SHELL_CACHE = "kontroll-report-shell-v1";
const ASSET_CACHE = "kontroll-report-assets-v1";
const reportPath = /^\/(et|en)\/a\/([0-9a-f-]{36})\/?$/i;

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

function shellMarker(html: string) {
  return html.includes('data-report-shell="true"');
}

async function cacheShell(path: string, observedAssets: string[]): Promise<boolean> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    headers: { "x-kontroll-offline-shell": "1" },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return false;
  const html = await response.clone().text();
  if (!shellMarker(html)) return false;
  const cache = await caches.open(SHELL_CACHE);
  const existing = await cache.keys();
  await Promise.all(existing.map((key) => cache.delete(key)));
  await cache.put(path, response);

  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:\?[^"]*)?"/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  assets.push(...observedAssets.filter((asset) => asset.startsWith("/_next/static/") && !asset.includes("?")));
  const assetCache = await caches.open(ASSET_CACHE);
  await Promise.all([...new Set(assets)].map(async (asset) => {
    try {
      const loaded = await fetch(asset);
      if (loaded.ok) await assetCache.put(asset, loaded);
    } catch {
      // An asset can still be requested while online; no error is cached.
    }
  }));
  return true;
}

worker.addEventListener("message", (event) => {
  const data = event.data as { type?: string; path?: string; assets?: string[] } | null;
  if (!data || typeof data.path !== "string" || !reportPath.test(data.path)) return;
  if (data.type === "CACHE_REPORT_SHELL") {
    event.waitUntil(cacheShell(data.path, Array.isArray(data.assets) ? data.assets : []).then((cached) => {
      event.ports[0]?.postMessage(cached);
    }).catch(() => event.ports[0]?.postMessage(false)));
  } else if (data.type === "CLEAR_REPORT_SHELL") {
    event.waitUntil(Promise.all([caches.delete(SHELL_CACHE), caches.delete(ASSET_CACHE)]).then(() => {
      event.ports[0]?.postMessage(true);
    }));
  }
});

function noCopyDocument(locale: string): Response {
  const et = locale === "et";
  const title = et ? "Selle raporti kohalikku koopiat pole" : "No local copy of this report is available";
  const detail = et ? "Ühenda internetiga ja ava privaatne raport uuesti." : "Connect to the internet and open the private report again.";
  return new Response(`<!doctype html><html lang="${et ? "et" : "en"}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#141d29;color:#edf1f5;font:16px Arial,sans-serif"><main style="max-width:45rem;padding:3rem 1rem"><h1>${title}</h1><p style="color:#abb9c9;line-height:1.6">${detail}</p></main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin || event.request.method !== "GET") return;
  const report = reportPath.exec(url.pathname);
  if (event.request.mode === "navigate" && report && !url.search) {
    event.respondWith((async () => {
      try {
        return await fetch(event.request);
      } catch {
        return await (await caches.open(SHELL_CACHE)).match(url.pathname) ?? noCopyDocument(report[1] ?? "en");
      }
    })());
    return;
  }
  if (!url.pathname.startsWith("/_next/static/") || url.search) return;
  event.respondWith((async () => {
    const hasAuthorizedShell = (await (await caches.open(SHELL_CACHE)).keys()).length > 0;
    try {
      const response = await fetch(event.request);
      if (hasAuthorizedShell && response.ok) await (await caches.open(ASSET_CACHE)).put(event.request, response.clone());
      return response;
    } catch {
      return hasAuthorizedShell
        ? await (await caches.open(ASSET_CACHE)).match(event.request) ?? Response.error()
        : Response.error();
    }
  })());
});
