import type { Locale } from "@/domain/analysis";
import { AnalysisReportSchema } from "@/domain/schemas";
import { cacheShells, removeShells, releaseWorkerIfEmpty, withOfflineLifecycle } from "./worker-client";
import { offlineLifetimeMs } from "./expiry";
import { deleteSavedReport, getSavedReport, markOfflineReady, putSavedReport, savedReportsAvailable, type SavedReportRecord } from "./saved-reports-db";

export type SaveResult =
  | { status: "saved"; record: SavedReportRecord }
  | { status: "offline-pending"; record: SavedReportRecord }
  | { status: "cancelled" }
  | { status: "access-denied" }
  | { status: "storage-full" }
  | { status: "unavailable" }
  | { status: "failed" };
const inFlight = new Map<string, Set<{cancelled:boolean}>>();
let requestedPersistence = false;

function removalKey(publicId: string): string {
  return `kontroll-offline:removed:${publicId}`;
}

export async function saveReport(publicId: string, locale: Locale): Promise<SaveResult> {
  if (!savedReportsAvailable()) return {status:"unavailable"};
  // Shared tokens contain cancellation metadata only, never report contents.
  let generation: string | null;
  try { generation = localStorage.getItem(removalKey(publicId)); }
  catch { return {status:"unavailable"}; }
  const operation = {cancelled:false};
  let generationUnavailable = false;
  const operations = inFlight.get(publicId) ?? new Set();
  operations.add(operation);
  inFlight.set(publicId, operations);
  try {
    if (!requestedPersistence) {
      requestedPersistence = true;
      void navigator.storage?.persist?.().catch(() => undefined);
    }
    const url = `/api/analyses/${encodeURIComponent(publicId)}`;
    const access = await fetch(`${url}/access`, {method:"PUT"});
    if (operation.cancelled) return {status:"cancelled"};
    if (access.status === 401 || access.status === 403) return {status:"access-denied"};
    if (!access.ok) return {status:"failed"};
    const response = await fetch(`${url}/report`, {cache:"no-store"});
    if (operation.cancelled) return {status:"cancelled"};
    if (response.status === 401 || response.status === 403) return {status:"access-denied"};
    if (!response.ok) return {status:"failed"};
    // The background check PDF link needs the network, so the device copy leaves it out.
    const online = await response.json();
    delete online?.backgroundCheck;
    const report = AnalysisReportSchema.parse(online);
    if (report.publicId !== publicId) return {status:"failed"};
    const previous = await getSavedReport(publicId);
    if (operation.cancelled) return {status:"cancelled"};
    const now = Date.now();
    const record: SavedReportRecord = {schemaVersion:1, publicId, locale, report, offlineReady:false, savedAt:new Date(now).toISOString(), expiresAt:new Date(now+offlineLifetimeMs()).toISOString(), checklist:previous?.checklist ?? {}};
    return await withOfflineLifecycle(async () => {
      await putSavedReport(record, () => {
        if (operation.cancelled) return false;
        try {
          operation.cancelled = localStorage.getItem(removalKey(publicId)) !== generation;
          return !operation.cancelled;
        } catch {
          generationUnavailable = true;
          return false;
        }
      });
      if (generationUnavailable) return {status:"unavailable"};
      if (operation.cancelled) return {status:"cancelled"} as const;
      const ready = await cacheShells(publicId);
      if (operation.cancelled || localStorage.getItem(removalKey(publicId)) !== generation) return {status:"cancelled"} as const;
      if (!ready) return {status:"offline-pending",record} as const;
      const committed = await markOfflineReady(record, () => !operation.cancelled && localStorage.getItem(removalKey(publicId)) === generation);
      if (!committed) return {status:"cancelled"} as const;
      return {status:"saved",record:{...record, offlineReady:true}} as const;
    });
  } catch (error) {
    if (operation.cancelled) return {status:"cancelled"};
    if (error instanceof DOMException && error.name === "QuotaExceededError") return {status:"storage-full"};
    return {status:savedReportsAvailable() ? "failed" : "unavailable"};
  } finally {
    operations.delete(operation);
    if (!operations.size) inFlight.delete(publicId);
  }
}
export async function removeSavedReport(publicId: string): Promise<void> {
  // Fail before deleting if shared cancellation cannot be recorded. Otherwise
  // an in-flight request in another tab could restore a report after removal.
  localStorage.setItem(removalKey(publicId), crypto.randomUUID());
  for (const operation of inFlight.get(publicId) ?? []) operation.cancelled = true;
  await withOfflineLifecycle(async () => {
    await deleteSavedReport(publicId);
    await removeShells(publicId);
  });
  await releaseWorkerIfEmpty();
}

// Retry preparation from device JSON; no access renewal or report fetch is needed.
export async function retryOfflinePreparation(publicId: string): Promise<SaveResult> {
  try {
    const generation = localStorage.getItem(removalKey(publicId));
    const record = await getSavedReport(publicId);
    if (!record) return {status:"cancelled"};
    return await withOfflineLifecycle(async () => {
      const ready = await cacheShells(publicId);
      if (localStorage.getItem(removalKey(publicId)) !== generation) return {status:"cancelled"};
      if (!ready) return {status:"offline-pending",record};
      const committed = await markOfflineReady(record, () => localStorage.getItem(removalKey(publicId)) === generation);
      if (!committed) return {status:"cancelled"};
      return {status:"saved",record:{...record,offlineReady:true}};
    });
  } catch { return {status:"failed"}; }
}
