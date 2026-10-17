import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sampleReport } from "../../fixtures/sample-report";
import * as db from "@/features/offline/saved-reports-db";
import { removeSavedReport, saveReport } from "@/features/offline/save-report";
const report = (id = "A") => ({
    ...sampleReport,
    publicId: id
});
beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES", "");
    for (const row of await db.listSavedReports())
        await db.deleteSavedReport(row.publicId);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("access") ? new Response(null, {
        status: 204
    }) : Response.json(report(url.includes("/B/") ? "B" : "A"))));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("saves with expiresAt 30 days after savedAt", async () => {
    const result = await saveReport("A", "en");
    expect(result.status).toBe("saved");
    if (result.status === "saved")
        expect(Date.parse(result.record.expiresAt) - Date.parse(result.record.savedAt)).toBe(2592000000);
    expect(await db.getSavedReport("A")).not.toBeNull();
});
it("uses NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES outside production", async () => {
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES", "2");
    const result = await saveReport("A", "et");
    if (result.status !== "saved")
        throw Error(result.status);
    expect(Date.parse(result.record.expiresAt) - Date.parse(result.record.savedAt)).toBe(120000);
    expect(result.record.locale).toBe("et");
});
it.each([401, 403])("returns access-denied on %s and keeps an existing record", async (status) => { await saveReport("A", "en"); const previous = await db.getSavedReport("A"); vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
    status
}))); expect(await saveReport("A", "en")).toEqual({
    status: "access-denied"
}); expect(await db.getSavedReport("A")).toEqual(previous); });
it("returns storage-full on QuotaExceededError", async () => { vi.spyOn(db, "putSavedReport").mockRejectedValue(new DOMException("Full", "QuotaExceededError")); expect(await saveReport("A", "en")).toEqual({
    status: "storage-full"
}); });
it("remove during report fetch returns cancelled and leaves no record", async () => {
    let finish!: (r: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(r => started = r);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("access"))
            return new Response(null, {
                status: 204
            });
        started();
        return new Promise<Response>(r => finish = r);
    }));
    const saving = saveReport("A", "en");
    await ready;
    await removeSavedReport("A");
    finish(Response.json(report()));
    expect(await saving).toEqual({
        status: "cancelled"
    });
    expect(await db.getSavedReport("A")).toBeNull();
});
it("saving A never changes B", async () => { await saveReport("B", "en"); const b = await db.getSavedReport("B"); await saveReport("A", "et"); expect(await db.getSavedReport("B")).toEqual(b); });
it.each(["0", "-1", "nonsense"])("ignores invalid expiry override %s", async (value) => {
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES", value);
    const result = await saveReport("A", "en");
    if (result.status !== "saved")
        throw Error(result.status);
    expect(Date.parse(result.record.expiresAt) - Date.parse(result.record.savedAt)).toBe(2592000000);
});
it("ignores expiry override in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES", "2");
    const result = await saveReport("A", "en");
    if (result.status !== "saved")
        throw Error(result.status);
    expect(Date.parse(result.record.expiresAt) - Date.parse(result.record.savedAt)).toBe(2592000000);
});
it("rejects a report belonging to another publicId", async () => { vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("access") ? new Response(null, {
    status: 204
}) : Response.json(report("B")))); expect(await saveReport("A", "en")).toEqual({
    status: "failed"
}); expect(await db.listSavedReports()).toEqual([]); });
