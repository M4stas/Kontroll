import type { AnalysisReport, Locale } from "@/domain/analysis";
import { AnalysisReportSchema } from "@/domain/schemas";

export type SavedReportRecord = {
  schemaVersion: 1;
  publicId: string;
  locale: Locale;
  report: AnalysisReport;
  savedAt: string;
  expiresAt: string;
  checklist: Record<string, boolean>;
};

let unavailable = false;
let pendingWrite: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function notify() { for (const listener of listeners) listener(); }
function broadcastChannel() {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("kontroll-offline");
    channel.onmessage = notify;
  }
  return channel;
}
export function subscribeSavedReports(listener: () => void): () => void {
  listeners.add(listener);
  broadcastChannel();
  return () => { listeners.delete(listener); };
}
export function savedReportsAvailable(): boolean {
  return typeof indexedDB !== "undefined" && !unavailable;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open("kontroll-offline", 1); }
    catch (error) { unavailable = true; reject(error); return; }
    request.onupgradeneeded = () => request.result.createObjectStore("reports", {keyPath:"publicId"});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { unavailable = true; reject(request.error); };
    request.onblocked = () => { unavailable = true; reject(new Error("IndexedDB blocked")); };
  });
}
function orderedWrite(work: () => Promise<void>): Promise<void> {
  const result = pendingWrite.then(work);
  pendingWrite = result.catch(() => undefined);
  return result;
}
async function mutate(work: (store: IDBObjectStore) => void): Promise<void> {
  return orderedWrite(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("reports", "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
        work(tx.objectStore("reports"));
      });
    } finally { db.close(); }
    notify();
    broadcastChannel()?.postMessage(null);
  });
}
export function putSavedReport(record: SavedReportRecord): Promise<void> {
  return mutate(store => { store.put(record); });
}
export function deleteSavedReport(publicId: string): Promise<void> {
  return mutate(store => { store.delete(publicId); });
}
function valid(record: SavedReportRecord): boolean {
  const parsed = AnalysisReportSchema.safeParse(record.report);
  return record.schemaVersion === 1 && Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.now() && parsed.success && parsed.data.publicId === record.publicId;
}
// A different tab may replace the readonly snapshot before cleanup runs.
// Revalidate under the same transaction lock that performs the deletion.
async function cleanInvalidReport(publicId: string): Promise<SavedReportRecord | null> {
  let current: SavedReportRecord | null = null;
  await mutate(store => {
    const request = store.get(publicId);
    request.onsuccess = () => {
      const record = request.result as SavedReportRecord | undefined;
      if (!record) return;
      if (valid(record)) current = record;
      else store.delete(publicId);
    };
  });
  return current;
}
async function readAll(): Promise<SavedReportRecord[]> {
  await pendingWrite;
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("reports", "readonly").objectStore("reports").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function getSavedReport(publicId: string): Promise<SavedReportRecord | null> {
  const record = (await readAll()).find(row => row.publicId === publicId);
  if (!record) return null;
  if (valid(record)) return record;
  return cleanInvalidReport(publicId);
}
export async function listSavedReports(): Promise<SavedReportRecord[]> {
  const records = await readAll();
  const live: SavedReportRecord[] = [];
  for (const record of records) {
    if (valid(record)) live.push(record);
    else {
      const current = await cleanInvalidReport(record.publicId);
      if (current) live.push(current);
    }
  }
  return live.sort((a,b) => Date.parse(b.savedAt)-Date.parse(a.savedAt));
}
