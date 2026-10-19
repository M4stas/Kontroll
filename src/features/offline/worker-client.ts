import { hasLiveSavedReports } from "./saved-reports-db";

const waitMs = 4000;
function bounded<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), waitMs);
    promise.then(value => {clearTimeout(timer); resolve(value);}, () => {clearTimeout(timer); resolve(fallback);});
  });
}
function ownWorker(worker: ServiceWorker | null): boolean {
  return !!worker && worker.scriptURL === new URL("/sw.js", location.origin).href;
}
function ownRegistration(registration: ServiceWorkerRegistration): boolean {
  const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
  return workers.length > 0 && workers.every(worker => ownWorker(worker));
}
export async function ensureWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  try { return await bounded(navigator.serviceWorker.register("/sw.js", {scope:"/"}), null); }
  catch { return null; }
}
async function readyWorker(worker: ServiceWorker): Promise<ServiceWorker | null> {
  if (!ownWorker(worker) || worker.state === "redundant") return null;
  if (worker.state === "activated" || worker.state === "installed") return worker;
  return new Promise(resolve => {
    const finish = (value: ServiceWorker | null) => { clearTimeout(timer); worker.removeEventListener("statechange", changed); resolve(value); };
    const changed = () => {
      if (worker.state === "activated" || worker.state === "installed") finish(worker);
      else if (worker.state === "redundant") finish(null);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    worker.addEventListener("statechange", changed);
    changed();
  });
}
async function post(worker: ServiceWorker, type: string, publicId: string): Promise<boolean> {
  if (!await readyWorker(worker) || typeof MessageChannel === "undefined") return false;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ok: boolean) => {clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(ok);};
    const timer = setTimeout(() => finish(false), waitMs);
    channel.port1.onmessage = event => finish(event.data?.ok === true);
    channel.port1.onmessageerror = () => finish(false);
    try {worker.postMessage({type, publicId}, [channel.port2]);} catch {finish(false);}
  });
}
async function message(registration: ServiceWorkerRegistration | null, type: string, publicId: string): Promise<boolean> {
  if (!registration) return false;
  const workers = [...new Set([registration.active, registration.waiting, registration.installing])]
    .filter((worker): worker is ServiceWorker => !!worker && ownWorker(worker));
  const replies = await Promise.all(workers.map(worker => post(worker, type, publicId)));
  return replies.length > 0 && replies.every(Boolean);
}
export async function cacheShells(publicId: string): Promise<boolean> {
  return message(await ensureWorker(), "cache-shells", publicId);
}
export async function removeShells(publicId: string): Promise<boolean> {
  try {
    const registration = navigator.serviceWorker ? await bounded(navigator.serviceWorker.getRegistration("/"), undefined) : undefined;
    const replied = await message(registration ?? null, "remove-shells", publicId);
    // Clean every app build too, including a failed installation's partial cache.
    if (typeof caches !== "undefined") for (const name of await caches.keys()) {
      if (!name.startsWith("kontroll-offline-")) continue;
      const cache = await caches.open(name);
      for (const locale of ["et", "en"]) await cache.delete(new URL(`/${locale}/r/${encodeURIComponent(publicId)}`, location.origin).href);
    }
    return replied;
  } catch {return false;}
}
// Shared with save/remove commits so a last-report release cannot erase a new save.
let lifecycle: Promise<unknown> = Promise.resolve();
export function withOfflineLifecycle<T>(work: () => Promise<T>): Promise<T> {
  const run = () => typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("kontroll-offline-lifecycle", work) : work();
  const result = lifecycle.then(run, run);
  lifecycle = result.catch(() => undefined);
  return result;
}
export async function releaseWorkerIfEmpty(): Promise<void> {
  return withOfflineLifecycle(async () => {
    try {
      if (await hasLiveSavedReports()) return;
      const registration = navigator.serviceWorker ? await bounded(navigator.serviceWorker.getRegistration("/"), undefined) : undefined;
      if (registration && ownRegistration(registration)) await bounded(registration.unregister(), false);
      if (typeof caches !== "undefined") for (const name of await caches.keys()) {
        if (name.startsWith("kontroll-offline-")) await caches.delete(name);
      }
    } catch { /* Device data remains usable without worker support. */ }
  });
}
