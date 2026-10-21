import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sampleReport } from "../../fixtures/sample-report";
import * as worker from "@/features/offline/worker-client";
import * as db from "@/features/offline/saved-reports-db";
import { removeSavedReport, saveReport } from "@/features/offline/save-report";
const report = (id = "A") => ({
    ...sampleReport,
    publicId: id
});
beforeEach(async () => {
    vi.useRealTimers();
    vi.spyOn(worker, "cacheShells").mockResolvedValue(true);
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
it("removal in another tab prevents a pending fetch from restoring the report", async () => {
    vi.resetModules();
    const tabA = await import("@/features/offline/save-report");
    vi.resetModules();
    const tabB = await import("@/features/offline/save-report");
    let finish!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("access")) return new Response(null, { status: 204 });
        started();
        return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const saving = tabA.saveReport("A", "en");
    await ready;
    await tabB.removeSavedReport("A");
    finish(Response.json(report()));
    expect(await saving).toEqual({ status: "cancelled" });
    expect(await db.getSavedReport("A")).toBeNull();
});
it("fails safely when shared cancellation storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    expect(await saveReport("A", "en")).toEqual({ status: "unavailable" });
    expect(await db.getSavedReport("A")).toBeNull();
});
it("keeps an existing report when writing the shared removal token exceeds quota", async () => {
    await saveReport("A", "en");
    const existing = await db.getSavedReport("A");
    const quota = new DOMException("Full", "QuotaExceededError");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw quota; });
    await expect(removeSavedReport("A")).rejects.toBe(quota);
    expect(await db.getSavedReport("A")).toEqual(existing);
});
it("allows a new save started after removal", async () => {
    await removeSavedReport("A");
    expect((await saveReport("A", "en")).status).toBe("saved");
    expect(await db.getSavedReport("A")).not.toBeNull();
});
it("removal during shell caching cancels the save and waits before removing shells", async () => {
    const worker = await import("@/features/offline/worker-client");
    const {saveReport, removeSavedReport} = await import("@/features/offline/save-report");
    let finish!: (ok: boolean) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => started = resolve);
    const events: string[] = [];
    vi.spyOn(worker, "cacheShells").mockImplementation(async () => {
        started(); await new Promise<boolean>(resolve => finish = resolve); events.push("cached"); return true;
    });
    vi.spyOn(worker, "removeShells").mockImplementation(async () => {events.push("removed"); return true;});
    const saving = saveReport("A", "en");
    await ready;
    const removing = removeSavedReport("A");
    expect(events).toEqual([]);
    finish(true);
    expect(await saving).toEqual({status:"cancelled"});
    await removing;
    expect(events).toEqual(["cached", "removed"]);
    expect(await db.getSavedReport("A")).toBeNull();
});
it("last-report release queued beside a new save keeps the new report", async () => {
    const worker = await import("@/features/offline/worker-client");
    const {saveReport, removeSavedReport} = await import("@/features/offline/save-report");
    vi.spyOn(worker, "cacheShells").mockResolvedValue(true);
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => started = resolve);
    vi.spyOn(worker, "removeShells").mockImplementation(async () => {started(); await new Promise<void>(resolve => finish = resolve);return true;});
    await saveReport("A", "en");
    const removing = removeSavedReport("A");
    await ready;
    const saving = saveReport("B", "en");
    finish();
    await removing;
    expect((await saving).status).toBe("saved");
    expect(await db.getSavedReport("B")).not.toBeNull();
});

it("keeps device JSON but reports pending offline readiness when shell caching fails", async () => {
 vi.mocked(worker.cacheShells).mockResolvedValue(false);
 const result = await saveReport("A", "en");
 expect(result.status).toBe("offline-pending");
 expect(await db.getSavedReport("A")).toMatchObject({offlineReady:false});
 vi.mocked(worker.cacheShells).mockResolvedValue(true);
 expect((await saveReport("A", "en")).status).toBe("saved");
 expect(await db.getSavedReport("A")).toMatchObject({offlineReady:true});
});

it("never reports ready when another tab removes JSON during preparation", async () => {
 vi.mocked(worker.cacheShells).mockImplementation(async () => {
   localStorage.setItem("kontroll-offline:removed:A",crypto.randomUUID());
   await db.deleteSavedReport("A");
   return true;
 });
 expect(await saveReport("A","en")).toEqual({status:"cancelled"});
 expect(await db.getSavedReport("A")).toBeNull();
});
