import { createWorkerHandlers } from "./handlers";

declare const BUILD_VERSION: string;
declare const self: ServiceWorkerGlobalScope;

function savedPublicIds(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kontroll-offline", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("reports", {keyPath:"publicId"});
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("reports", "readonly");
      const keys = tx.objectStore("reports").getAllKeys();
      tx.oncomplete = () => { db.close(); resolve(keys.result.filter((key): key is string => typeof key === "string")); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const handlers = createWorkerHandlers({caches: self.caches, fetch: self.fetch.bind(self), origin: self.location.origin, buildVersion: BUILD_VERSION, savedPublicIds});
self.addEventListener("install", event => event.waitUntil(handlers.install()));
self.addEventListener("activate", event => event.waitUntil(handlers.activate().then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const response = handlers.handleFetch(event.request);
  if (response) event.respondWith(response);
});
self.addEventListener("message", event => {
  event.waitUntil(handlers.handleMessage(event.data).then(reply => event.ports[0]?.postMessage(reply)));
});
