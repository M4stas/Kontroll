import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { sampleReport } from "../../fixtures/sample-report";
import * as worker from "@/features/offline/worker-client";
import * as savedReportsDb from "@/features/offline/saved-reports-db";
import { deleteSavedReport, getSavedReport, putSavedReport, type SavedReportRecord } from "@/features/offline/saved-reports-db";
import { needsIosStorageWarning } from "@/features/offline/ios-storage-warning";
import { SaveStrip } from "@/features/offline/save-strip";

const publicId = "save-strip-test-report";
const report = { ...sampleReport, publicId, updatedAt: "2026-10-17T08:00:00.000Z" };

function renderStrip(locale: "en" | "et" = "en", currentReport = report) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : et} timeZone="Europe/Tallinn">
      <SaveStrip report={currentReport} locale={locale} />
    </NextIntlClientProvider>,
  );
}

function savedRecord(overrides: Partial<SavedReportRecord> = {}): SavedReportRecord {
  return {
    schemaVersion: 1,
    publicId,
    locale: "en",
    report: { ...report, updatedAt: "2026-10-16T08:00:00.000Z" },
    savedAt: "2026-10-16T08:00:00.000Z",
    expiresAt: "2026-11-15T08:00:00.000Z",
    checklist: {},
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useRealTimers();
  vi.spyOn(worker, "cacheShells").mockResolvedValue(true);
  await deleteSavedReport(publicId);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/access")) return new Response(null, { status: 204 });
    return Response.json(report);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SaveStrip", () => {
  it("shows Save on this device when nothing is saved", async () => {
    renderStrip();

    expect(await screen.findByRole("button", { name: "Save on this device" })).toBeVisible();
    expect(screen.queryByText(/Saved .* kept until/)).toBeNull();
  });

  it.each([
    { locale: "en" as const, save: "Save on this device", update: "Update saved copy", dates: "Saved Oct 17, 2026 · kept until Nov 16, 2026" },
    { locale: "et" as const, save: "Salvesta sellesse seadmesse", update: "Uuenda salvestatud koopiat", dates: "Salvestatud 17. okt 2026 · säilib kuni 16. nov 2026" },
  ])("after saving shows the saved date and kept-until date in the $locale locale", async ({ locale, save, update, dates }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T09:00:00.000Z"));
    renderStrip(locale);

    fireEvent.click(await screen.findByRole("button", { name: save }));

    expect(await screen.findByRole("button", { name: update })).toBeVisible();
    expect(await screen.findByText(dates)).toBeVisible();
  });

  it("shows a newer-version notice when report.updatedAt is later than the saved copy", async () => {
    await putSavedReport(savedRecord());
    renderStrip();

    expect(await screen.findByText("Newer version online")).toBeVisible();
  });

  it("Update replaces the copy and clears the notice", async () => {
    await putSavedReport(savedRecord());
    renderStrip();

    fireEvent.click(await screen.findByRole("button", { name: "Update saved copy" }));

    await waitFor(async () => {
      expect((await getSavedReport(publicId))?.report.updatedAt).toBe(report.updatedAt);
      expect(screen.queryByText("Newer version online")).toBeNull();
    });
  });

  it("Remove returns to the unsaved state", async () => {
    await putSavedReport(savedRecord());
    renderStrip();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByRole("button", { name: "Save on this device" })).toBeVisible();
    expect(await getSavedReport(publicId)).toBeNull();
  });

  it("access-denied says to open the private link again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    renderStrip();

    fireEvent.click(await screen.findByRole("button", { name: "Save on this device" }));

    expect(await screen.findByText("Open the private report link again, then try saving.")).toBeVisible();
  });

  it("keeps the saved copy when the private link is no longer authorized", async () => {
    const existing = savedRecord();
    await putSavedReport(existing);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    renderStrip();

    fireEvent.click(await screen.findByRole("button", { name: "Update saved copy" }));

    expect(await screen.findByText("Open the private report link again, then try saving.")).toBeVisible();
    expect(screen.getByText("Newer version online")).toBeVisible();
    expect(await getSavedReport(publicId)).toEqual(existing);
  });

  it("storage-full shows the storage message", async () => {
    vi.spyOn(savedReportsDb, "putSavedReport")
      .mockRejectedValue(new DOMException("Full", "QuotaExceededError"));
    renderStrip();

    fireEvent.click(await screen.findByRole("button", { name: "Save on this device" }));

    expect(await screen.findByText("This device is out of storage. Free up space and try again.")).toBeVisible();
  });

  it("unavailable shows Saving isn't available in this browser", async () => {
    vi.stubGlobal("indexedDB", undefined);
    renderStrip();

    expect(await screen.findByText("Saving isn't available in this browser.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save on this device" })).toBeNull();
  });

  it("shows the iPhone 7-day warning only when needsIosStorageWarning is true", async () => {
    const stubIosNavigator = (standalone: boolean) => {
      const value = Object.create(navigator) as Navigator & { standalone?: boolean };
      Object.defineProperty(value, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      });
      Object.defineProperty(value, "standalone", { configurable: true, value: standalone });
      return value;
    };
    vi.stubGlobal("navigator", stubIosNavigator(false));
    expect(needsIosStorageWarning()).toBe(true);
    const iosView = renderStrip();
    expect(await screen.findByText(/Safari can delete saved reports after 7 days/)).toBeVisible();
    iosView.unmount();

    vi.stubGlobal("navigator", stubIosNavigator(true));
    expect(needsIosStorageWarning()).toBe(false);
    renderStrip();
    await screen.findByRole("button", { name: "Save on this device" });
    expect(screen.queryByText(/Safari can delete saved reports after 7 days/)).toBeNull();
  });

  it("renders in Estonian", async () => {
    renderStrip("et");

    expect(await screen.findByRole("button", { name: "Salvesta sellesse seadmesse" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Salvesta raport sellesse seadmesse" })).toBeVisible();
  });
});

it.each(["en", "et"] as const)("persists truthful readiness and retries only shell preparation in %s", async locale => {
 vi.mocked(worker.cacheShells).mockResolvedValue(false);
 const view = renderStrip(locale);
 fireEvent.click(await screen.findByRole("button", {name:locale === "en" ? "Save on this device" : "Salvesta sellesse seadmesse"}));
 const messages = locale === "en" ? en : et;
 expect(await screen.findByText(messages.Report.offline.offlinePending)).toBeVisible();
 expect(await getSavedReport(publicId)).toMatchObject({offlineReady:false});
 view.unmount();
 renderStrip(locale);
 expect(await screen.findByText(messages.Report.offline.offlinePending)).toBeVisible();
 const requests = vi.mocked(fetch).mock.calls.length;
 vi.mocked(worker.cacheShells).mockResolvedValue(true);
 fireEvent.click(screen.getByRole("button", {name:messages.Report.offline.retryOffline}));
 await waitFor(()=>expect(screen.queryByText(messages.Report.offline.offlinePending)).toBeNull());
 expect(fetch).toHaveBeenCalledTimes(requests);
 expect(await getSavedReport(publicId)).toMatchObject({offlineReady:true});
});
