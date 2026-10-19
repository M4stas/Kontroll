import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { OfflineReport } from "@/features/offline/offline-report";
import { deleteSavedReport, putSavedReport } from "@/features/offline/saved-reports-db";
import { sampleReport } from "../../fixtures/sample-report";

const savedId = sampleReport.publicId;
const missingId = "61f5df99-01fd-4e8c-a15b-bb1a3de14332";
const savedAt = "2026-10-12T12:00:00.000Z";

function page(locale: "en" | "et", publicId: string) {
  return <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : et} timeZone="Europe/Tallinn">
    <OfflineReport locale={locale} publicId={publicId} />
  </NextIntlClientProvider>;
}

async function saveReport(publicId: string) {
  await putSavedReport({
    schemaVersion: 1,
    publicId,
    locale: "en",
    report: { ...sampleReport, publicId },
    savedAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    checklist: {},
  });
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await Promise.all([deleteSavedReport(savedId), deleteSavedReport(missingId)]);
});

describe("OfflineReport", () => {
  it("renders ReportView offline from the saved record", async () => {
    await saveReport(savedId);

    render(page("en", savedId));

    expect(await screen.findByRole("region", { name: "Report cards" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Save report on this device" })).toBeNull();
  });

  it("shows the saved date and warns that the copy may be out of date", async () => {
    await saveReport(savedId);

    render(page("en", savedId));

    expect(await screen.findByText("Saved on 12 Oct 2026. This copy may be out of date.")).toBeVisible();
  });

  it("says there is no saved copy and links to the current locale home", async () => {
    render(page("en", missingId));

    expect(await screen.findByText("No saved copy is available on this device.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to home" })).toHaveAttribute("href", "/en");
  });

  it("shows the same no-copy message when browser storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);

    render(page("en", missingId));

    expect(await screen.findByText("No saved copy is available on this device.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to home" })).toHaveAttribute("href", "/en");
  });

  it("renders the offline message in Estonian", async () => {
    await saveReport(savedId);

    render(page("et", savedId));

    expect(await screen.findByText("Salvestatud 12. okt 2026. See koopia võib olla aegunud.")).toBeVisible();
  });
});
