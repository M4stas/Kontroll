import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { OfflineReport } from "@/features/offline/offline-report";
import { sampleReport } from "../../fixtures/sample-report";

const { cacheReport, clearCachedReport, messageWorker } = vi.hoisted(() => ({
  cacheReport: vi.fn().mockResolvedValue(undefined),
  clearCachedReport: vi.fn().mockResolvedValue(undefined),
  messageWorker: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/features/offline/report-cache", () => ({ cacheReport, clearCachedReport, loadCachedReport: vi.fn() }));
vi.mock("@/features/offline/register-worker", () => ({ messageWorker }));
vi.mock("@/features/report/report-view", () => ({ ReportView: () => <article>Report content</article> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OfflineReport without a worker", () => {
  it.each([
    ["en", en, "Local report saved; offline reload unavailable", "Remove offline copy", "Offline copy removed"],
    ["et", et, "Kohalik raport salvestatud; võrguühenduseta uuesti avamine pole saadaval", "Eemalda kohalik koopia", "Kohalik koopia eemaldatud"],
  ] as const)("offers %s local-copy removal when worker registration fails", async (locale, messages, notice, clearLabel, removed) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...sampleReport, locale }) }));
    render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Tallinn">
        <OfflineReport locale={locale} publicId={sampleReport.publicId} serverReport={{ ...sampleReport, locale }} accessFallback={<div>Access required</div>} />
      </NextIntlClientProvider>,
    );

    expect(await screen.findByText(notice)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: clearLabel }));
    await waitFor(() => expect(clearCachedReport).toHaveBeenCalledWith(sampleReport.publicId));
    expect(await screen.findByText(removed)).toBeVisible();
  });
});
