import { beforeEach, expect, it, vi } from "vitest";
import { sampleReport } from "../../fixtures/sample-report";
import { deleteSavedReport, getSavedReport, listSavedReports, putSavedReport, savedReportsAvailable, subscribeSavedReports, type SavedReportRecord } from "@/features/offline/saved-reports-db";
export function record(publicId = "A"): SavedReportRecord { return {
    schemaVersion: 1,
    publicId,
    locale: "en",
    report: {
        ...sampleReport,
        publicId
    },
    savedAt: "2026-10-17T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    checklist: {}
}; }
beforeEach(async () => {
    for (const row of await listSavedReports())
        await deleteSavedReport(row.publicId);
});
it("put then get returns the record", async () => { await putSavedReport(record()); expect(await getSavedReport("A")).toEqual(record()); });
it.each(["expired", "invalid", "version"])("get deletes a %s record", async (kind) => {
    const row = record();
    if (kind === "expired")
        row.expiresAt = "2000-01-01";
    if (kind === "invalid")
        row.report = {} as SavedReportRecord["report"];
    if (kind === "version")
        (row as {
            schemaVersion: number;
        }).schemaVersion = 2;
    await putSavedReport(row);
    expect(await getSavedReport("A")).toBeNull();
    expect(await listSavedReports()).toEqual([]);
});
it("delete removes only that publicId", async () => { await putSavedReport(record()); await putSavedReport(record("B")); await deleteSavedReport("A"); expect(await getSavedReport("B")).toEqual(record("B")); });
it("list orders by savedAt newest first", async () => { await putSavedReport(record()); await putSavedReport({
    ...record("B"),
    savedAt: "2026-10-18T00:00:00Z"
}); expect((await listSavedReports()).map(x => x.publicId)).toEqual(["B", "A"]); });
it("subscribe fires for a write", async () => { const listener = vi.fn(); const off = subscribeSavedReports(listener); await putSavedReport(record()); off(); expect(listener).toHaveBeenCalledOnce(); });
it("savedReportsAvailable is false when indexedDB is undefined", () => { vi.stubGlobal("indexedDB", undefined); expect(savedReportsAvailable()).toBe(false); vi.unstubAllGlobals(); });
it("orders writes and deletion even when started together", async () => { await Promise.all([putSavedReport(record()), deleteSavedReport("A"), putSavedReport(record("B"))]); expect(await getSavedReport("A")).toBeNull(); expect(await getSavedReport("B")).not.toBeNull(); });
it("receives notifications from another tab", async () => { const other = new BroadcastChannel("kontroll-offline"); const notification = new Promise<void>(resolve => { const off = subscribeSavedReports(() => { off(); resolve(); }); }); other.postMessage(null); await notification; other.close(); });
it("marks storage unavailable after opening fails", async () => {
    vi.resetModules();
    const isolated = await import("@/features/offline/saved-reports-db");
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    await expect(isolated.getSavedReport("A")).rejects.toThrow("Blocked");
    expect(isolated.savedReportsAvailable()).toBe(false);
    open.mockRestore();
});
