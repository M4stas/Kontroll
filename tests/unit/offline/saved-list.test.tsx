import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleReport } from "../../fixtures/sample-report";
import {
  deleteSavedReport,
  getSavedReport,
  listSavedReports,
  putSavedReport,
  type SavedReportRecord,
} from "@/features/offline/saved-reports-db";
import { SavedList } from "@/features/offline/saved-list";

function savedRecord(
  publicId: string,
  title: string,
  savedAt: string,
  expiresAt: string,
): SavedReportRecord {
  return {
    schemaVersion: 1,
    publicId,
    locale: "en",
    report: {
      ...sampleReport,
      publicId,
      vehicleFacts: sampleReport.vehicleFacts.map((fact) =>
        fact.key === "make_model" ? { ...fact, value: title } : fact,
      ),
    },
    savedAt,
    expiresAt,
    checklist: {},
  };
}

function renderList(locale: "en" | "et" = "en") {
  return render(<SavedList locale={locale} />);
}

async function writeInOtherTab(record: SavedReportRecord): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kontroll-offline", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("reports", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
      transaction.objectStore("reports").put(record);
    });
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  for (const record of await listSavedReports()) {
    await deleteSavedReport(record.publicId);
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SavedList", () => {
  it("renders nothing when no report is saved", async () => {
    renderList();

    await waitFor(async () => {
      expect(await listSavedReports()).toEqual([]);
    });
    expect(screen.queryByRole("heading", { name: "Saved on this device" })).toBeNull();
  });

  it("lists reports newest first with title, saved date and kept-until date", async () => {
    await putSavedReport(savedRecord("older", "Volvo V60", "2026-10-16T12:00:00.000Z", "2026-11-15T12:00:00.000Z"));
    await putSavedReport(savedRecord("newer", "Toyota Avensis", "2026-10-17T12:00:00.000Z", "2026-11-16T12:00:00.000Z"));

    renderList();

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [newestRow, oldestRow] = rows;
    if (!newestRow || !oldestRow) throw new Error("Expected both saved report rows");
    expect(newestRow).toHaveTextContent("Toyota Avensis");
    expect(newestRow).toHaveTextContent("Saved 17 Oct 2026 · kept until 16 Nov 2026");
    expect(oldestRow).toHaveTextContent("Volvo V60");
    expect(oldestRow).toHaveTextContent("Saved 16 Oct 2026 · kept until 15 Nov 2026");
  });

  it.each([
    { locale: "en" as const, label: "Open", href: "/en/r/saved-link-en" },
    { locale: "et" as const, label: "Ava", href: "/et/r/saved-link-et" },
  ])("links Open to the $locale report path", async ({ locale, label, href }) => {
    const publicId = locale === "en" ? "saved-link-en" : "saved-link-et";
    await putSavedReport(savedRecord(publicId, "Toyota Avensis", "2026-10-17T12:00:00.000Z", "2026-11-16T12:00:00.000Z"));

    renderList(locale);

    expect(await screen.findByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(screen.getByRole("link", { name: label })).toHaveClass("secondary-button");
  });

  it("Remove deletes only that report", async () => {
    await putSavedReport(savedRecord("remove-me", "Toyota Avensis", "2026-10-17T12:00:00.000Z", "2026-11-16T12:00:00.000Z"));
    await putSavedReport(savedRecord("keep-me", "Volvo V60", "2026-10-16T12:00:00.000Z", "2026-11-15T12:00:00.000Z"));

    renderList();

    const rows = await screen.findAllByRole("listitem");
    const [rowToRemove] = rows;
    if (!rowToRemove) throw new Error("Expected a saved report row");
    fireEvent.click(within(rowToRemove).getByRole("button", { name: "Remove" }));

    await waitFor(async () => {
      expect(await getSavedReport("remove-me")).toBeNull();
      expect(await getSavedReport("keep-me")).not.toBeNull();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem")).toHaveTextContent("Volvo V60");
  });

  it("updates when another tab saves a report", async () => {
    renderList();
    await waitFor(async () => expect(await listSavedReports()).toEqual([]));

    const channel = new BroadcastChannel("kontroll-offline");
    try {
      await writeInOtherTab(savedRecord("other-tab", "Škoda Octavia", "2026-10-17T12:00:00.000Z", "2026-11-16T12:00:00.000Z"));
      await act(async () => {
        channel.postMessage(null);
      });

      expect(await screen.findByText("Škoda Octavia")).toBeVisible();
    } finally {
      channel.close();
    }
  });

  it("renders nothing when savedReportsAvailable is false", () => {
    vi.stubGlobal("indexedDB", undefined);

    renderList();

    expect(screen.queryByRole("heading", { name: "Saved on this device" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders in Estonian", async () => {
    await putSavedReport(savedRecord("estonian", "Toyota Avensis", "2026-10-17T12:00:00.000Z", "2026-11-16T12:00:00.000Z"));

    renderList("et");

    expect(await screen.findByRole("heading", { name: "Selles seadmes salvestatud" })).toBeVisible();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Toyota Avensis");
    expect(row).toHaveTextContent("Salvestatud 17. okt 2026 · säilib kuni 16. nov 2026");
    expect(within(row).getByRole("link", { name: "Ava" })).toHaveAttribute("href", "/et/r/estonian");
    expect(within(row).getByRole("button", { name: "Eemalda" })).toBeVisible();
  });
});
