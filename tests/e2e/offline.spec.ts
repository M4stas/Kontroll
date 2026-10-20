import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { sampleReport } from "../fixtures/sample-report";

// This helper is injected only into the test browser, never the app bundle.
async function helper(page: Page) {
  const bundle = await build({
    stdin: { contents: `export * from './src/features/offline/saved-reports-db'; export * from './src/features/offline/worker-client'; export {removeSavedReport} from './src/features/offline/save-report';`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "iife", globalName: "offlineTest", platform: "browser",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
}

test("saved Estonian report and both front pages work entirely through the production worker offline", async ({ page, context }) => {
  await page.goto("/et");
  await helper(page);
  const publicId = sampleReport.publicId;
  expect(await page.evaluate(async ({ report }) => {
    const api = (window as unknown as { offlineTest: typeof import('../../src/features/offline/worker-client') & typeof import('../../src/features/offline/saved-reports-db') }).offlineTest;
    const now = Date.now();
    await api.putSavedReport({ schemaVersion: 1, publicId: report.publicId, locale: "et", report: { ...report, locale: "et" }, savedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), checklist: {} });
    return api.cacheShells(report.publicId);
  }, { report: sampleReport })).toBe(true);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const rows: {url: string; html: string}[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith("kontroll-offline-")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response?.headers.get("content-type")?.includes("text/html")) rows.push({ url: request.url, html: await response.text() });
      }
    }
    return rows;
  });
  expect(cached.map(row => new URL(row.url).pathname)).toEqual(expect.arrayContaining(["/et", "/en", `/et/r/${publicId}`, `/en/r/${publicId}`]));
  for (const row of cached) {
    expect(row.html).not.toContain("Toyota Avensis");
    expect(row.html).not.toContain("Service history is claimed");
    expect(row.html).not.toContain('"vehicleFacts"');
  }
  const responses: {url: string; worker: boolean}[] = [];
  const failed: string[] = [];
  page.on("response", response => responses.push({url: response.url(), worker: response.fromServiceWorker()}));
  page.on("requestfailed", request => failed.push(`${request.url()} ${request.failure()?.errorText}`));
  await context.setOffline(true);
  for (const locale of ["et", "en"]) {
    await page.goto(`/${locale}`);
    await expect(page.getByRole("status")).toContainText(locale === "en" ? "You're offline" : "Internetiühendus puudub");
    await expect(page.locator(".saved-report-row")).toContainText("Toyota Avensis");
    await page.locator(".saved-report-row a").click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/r/${publicId}$`));
    await expect(page.locator("main")).toContainText("Toyota Avensis");
    await page.getByRole("link", { name: locale === "et" ? "EN" : "ET", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale === "et" ? "en" : "et"}/r/${publicId}$`));
    await expect(page.locator("main")).toContainText("Toyota Avensis");
  }
  expect(failed).toEqual([]);
  expect(responses.length).toBeGreaterThan(4);
  expect(responses.filter(response => !response.worker)).toEqual([]);
});

test("expired records clean both locale shells without deleting unrelated caches", async ({ page }) => {
  await page.goto("/en");
  await helper(page);
  const result = await page.evaluate(async report => {
    const api = (window as unknown as { offlineTest: typeof import('../../src/features/offline/worker-client') & typeof import('../../src/features/offline/saved-reports-db') }).offlineTest;
    const now = Date.now();
    const record = { schemaVersion: 1 as const, publicId: report.publicId, locale: "et" as const, report, savedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), checklist: {} };
    await api.putSavedReport(record);
    if (!await api.cacheShells(report.publicId)) throw new Error("Shell caching failed");
    const other = await caches.open("unrelated-app");
    await other.put("/keep", new Response("preserved"));
    await api.putSavedReport({ ...record, expiresAt: new Date(now - 1).toISOString() });
    const saved = await api.listSavedReports();
    const shells: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith("kontroll-offline-")) continue;
      for (const request of await (await caches.open(name)).keys()) {
        if (new URL(request.url).pathname.includes(`/r/${report.publicId}`)) shells.push(request.url);
      }
    }
    return { saved, shells, other: await (await other.match("/keep"))?.text() };
  }, sampleReport);
  expect(result).toEqual({ saved: [], shells: [], other: "preserved" });
});
