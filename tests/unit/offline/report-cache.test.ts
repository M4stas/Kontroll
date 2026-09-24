import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheReport, clearCachedReport, loadCachedReport, loadChecklist, saveChecklist } from "@/features/offline/report-cache";
import { sampleReport } from "../../fixtures/sample-report";

// Small IndexedDB stand-in; the browser journey covers the native implementation.
function installDatabase(onGet?: () => Promise<void>) {
  const rows = new Map<string, unknown>();
  const request = (result?: unknown) => {
    const entry = { result, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => entry.onsuccess?.());
    return entry;
  };
  const store = {
    get: (id: string) => {
      const entry = { result: rows.get(id), onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
      void (onGet?.() ?? Promise.resolve()).then(() => queueMicrotask(() => entry.onsuccess?.()));
      return entry;
    },
    put: (value: { publicId: string }) => { rows.set(value.publicId, value); return request(); },
    clear: () => { rows.clear(); return request(); },
    delete: (id: string) => { rows.delete(id); return request(); },
  };
  const database = {
    close: () => undefined,
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const transaction = {
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        error: null,
        commit: () => queueMicrotask(() => transaction.oncomplete?.()),
        objectStore: () => ({
          ...store,
          put: (value: { publicId: string }) => {
            const result = store.put(value);
            queueMicrotask(() => transaction.oncomplete?.());
            return result;
          },
          delete: (id: string) => {
            const result = store.delete(id);
            queueMicrotask(() => transaction.oncomplete?.());
            return result;
          },
        }),
      };
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const entry = { result: database, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
      queueMicrotask(() => { entry.onupgradeneeded?.(); entry.onsuccess?.(); });
      return entry;
    },
  });
  return rows;
}

afterEach(() => vi.unstubAllGlobals());

describe("offline report cache", () => {
  it("keeps the latest validated report under its public ID", async () => {
    installDatabase();
    await cacheReport(sampleReport.publicId, sampleReport);
    expect(await loadCachedReport("other-analysis")).toBeNull();
    expect((await loadCachedReport(sampleReport.publicId))?.verdict).toBe("worth_viewing");
    await clearCachedReport(sampleReport.publicId);
    expect(await loadCachedReport(sampleReport.publicId)).toBeNull();
  });

  it("rejects malformed or mismatched data and never persists an access token", async () => {
    const rows = installDatabase();
    await expect(cacheReport("other-analysis", sampleReport)).rejects.toThrow();
    await expect(cacheReport(sampleReport.publicId, { ...sampleReport, verdict: "unsafe" } as never)).rejects.toThrow();
    await expect(cacheReport(sampleReport.publicId, { ...sampleReport, accessToken: "secret" } as never)).rejects.toThrow();
    expect(JSON.stringify([...rows.values()])).not.toContain("secret");
  });

  it("retains checklist marks for the current report and clears them with it", async () => {
    installDatabase();
    await cacheReport(sampleReport.publicId, sampleReport);
    await saveChecklist(sampleReport.publicId, ["inspect-cold-start"]);
    await cacheReport(sampleReport.publicId, { ...sampleReport, updatedAt: "2026-09-21T08:05:00.000Z" });
    expect(await loadChecklist(sampleReport.publicId)).toEqual(["inspect-cold-start"]);
    await clearCachedReport(sampleReport.publicId);
    expect(await loadChecklist(sampleReport.publicId)).toEqual([]);
  });

  it("replaces an older analysis when another report becomes the latest", async () => {
    installDatabase();
    await cacheReport(sampleReport.publicId, sampleReport);
    const nextId = "1c5fa159-2156-47a1-8f5f-e4d94c26db02";
    await cacheReport(nextId, { ...sampleReport, publicId: nextId });
    expect(await loadCachedReport(sampleReport.publicId)).toBeNull();
    expect((await loadCachedReport(nextId))?.publicId).toBe(nextId);
    await clearCachedReport(sampleReport.publicId);
    expect((await loadCachedReport(nextId))?.publicId).toBe(nextId);
  });

  it("does not resurrect a report when checklist persistence overlaps clear", async () => {
    let pause = false;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    installDatabase(async () => {
      if (pause) {
        readStarted();
        await readGate;
      }
    });
    await cacheReport(sampleReport.publicId, sampleReport);
    pause = true;
    const saving = saveChecklist(sampleReport.publicId, ["inspect-cold-start"]);
    await started;
    const clearing = clearCachedReport(sampleReport.publicId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pause = false;
    releaseRead();
    await Promise.all([saving, clearing]);
    expect(await loadCachedReport(sampleReport.publicId)).toBeNull();
    expect(await loadChecklist(sampleReport.publicId)).toEqual([]);
  });
});
