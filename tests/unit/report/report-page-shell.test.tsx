import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SHELL_HEADER } from "@/service-worker/routing";
import ReportPage from "@/app/[locale]/r/[publicId]/page";

const { headersMock, cookiesMock, loadReportMock, offlineReportMock, getTranslationsMock } = vi.hoisted(() => ({
  headersMock: vi.fn(),
  cookiesMock: vi.fn(),
  loadReportMock: vi.fn(),
  offlineReportMock: vi.fn<(props: { locale: string; publicId: string }) => null>(() => null),
  getTranslationsMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: headersMock, cookies: cookiesMock }));
vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn(), getTranslations: getTranslationsMock }));
vi.mock("@/features/report/load-report", () => ({
  loadReport: loadReportMock,
  ReportAccessError: class ReportAccessError extends Error {},
}));
vi.mock("@/features/offline/offline-report", () => ({ OfflineReport: offlineReportMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("with the shell header renders OfflineReport without loading a report or reading the cookie", async () => {
  const publicId = "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1";
  headersMock.mockResolvedValue(new Headers([[SHELL_HEADER, "1"]]));
  cookiesMock.mockResolvedValue({ get: vi.fn() });
  getTranslationsMock.mockResolvedValue((key: string) => key);

  render(await ReportPage({ params: Promise.resolve({ locale: "en", publicId }) }));

  expect(offlineReportMock).toHaveBeenCalledOnce();
  expect(offlineReportMock.mock.calls[0]?.[0]).toEqual({ locale: "en", publicId });
  expect(cookiesMock).not.toHaveBeenCalled();
  expect(loadReportMock).not.toHaveBeenCalled();
  expect(getTranslationsMock).not.toHaveBeenCalled();
});
