import type { AnalysisReport } from "@/domain/analysis";
import { AnalysisReportSchema } from "@/domain/schemas";

interface OfflineRecord {
  publicId: string;
  report: AnalysisReport;
  checklist: string[];
}

const DATABASE = "kontroll-offline-report";
const STORE = "reports";
let pendingMutation: Promise<void> = Promise.resolve();

function orderedMutation(work: () => Promise<void>): Promise<void> {
  const result = pendingMutation.then(work);
  pendingMutation = result.catch(() => undefined);
  return result;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "publicId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read(publicId: string): Promise<OfflineRecord | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(publicId);
      request.onsuccess = () => resolve((request.result as OfflineRecord | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function cacheReport(publicId: string, report: AnalysisReport): Promise<void> {
  const validated = AnalysisReportSchema.parse(report);
  if (validated.publicId !== publicId) throw new Error("Report ID mismatch");
  await orderedMutation(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        const store = transaction.objectStore(STORE);
        const previous = store.get(publicId);
        previous.onsuccess = () => {
          const checklist = (previous.result as OfflineRecord | undefined)?.checklist ?? [];
          const clear = store.clear();
          clear.onsuccess = () => store.put({ publicId, report: validated, checklist } satisfies OfflineRecord);
        };
      });
    } finally {
      db.close();
    }
  });
}

export async function loadCachedReport(publicId: string): Promise<AnalysisReport | null> {
  const record = await read(publicId);
  if (!record) return null;
  const parsed = AnalysisReportSchema.safeParse(record.report);
  return parsed.success && parsed.data.publicId === publicId ? parsed.data : null;
}

export async function saveChecklist(publicId: string, checked: string[]): Promise<void> {
  await orderedMutation(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        const store = transaction.objectStore(STORE);
        const current = store.get(publicId);
        current.onsuccess = () => {
          const record = current.result as OfflineRecord | undefined;
          if (record) store.put({ ...record, checklist: [...new Set(checked)] } satisfies OfflineRecord);
          else transaction.commit();
        };
      });
    } finally {
      db.close();
    }
  });
}

export async function loadChecklist(publicId: string): Promise<string[]> {
  const record = await read(publicId);
  return record?.checklist ?? [];
}

export async function clearCachedReport(publicId: string): Promise<void> {
  await orderedMutation(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore(STORE).delete(publicId);
      });
    } finally {
      db.close();
    }
  });
}
