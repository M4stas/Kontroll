import { cacheName, routeRequest, SHELL_HEADER, shellPaths, staticAssetsIn } from "./routing";

type Dependencies = {
  caches: CacheStorage;
  fetch: typeof fetch;
  origin: string;
  buildVersion: string;
  savedPublicIds: () => Promise<string[]>;
};
export function createWorkerHandlers(deps: Dependencies) {
  const name = cacheName(deps.buildVersion);
  const absolute = (path: string) => new URL(path, deps.origin).href;
  let messages: Promise<unknown> = Promise.resolve();
  const removals = new Map<string, number>();
  function validId(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const route = routeRequest(new URL(`/et/r/${value}`, deps.origin), deps.origin, "navigate", "GET");
    return route.kind === "report" && route.publicId === value;
  }
  async function fetchRequired(request: Request): Promise<Response> {
    const response = await deps.fetch(request);
    if (!response.ok || response.redirected) throw new Error(`Offline cache request failed: ${request.url}`);
    return response;
  }
  async function cachePages(paths: string[], publicId?: string, generation = 0) {
    const stillSaved = async () => !publicId || (
      (removals.get(publicId) ?? 0) === generation && (await deps.savedPublicIds()).includes(publicId)
    );
    if (!await stillSaved()) return;
    const cache = await deps.caches.open(name);
    for (const path of paths) {
      const request = new Request(absolute(path), {headers: publicId ? {[SHELL_HEADER]: "1"} : {}, cache: "reload"});
      const response = await fetchRequired(request);
      const html = await response.clone().text();
      for (const asset of staticAssetsIn(html)) {
        const url = absolute(asset);
        if (!await cache.match(url)) await cache.put(url, await fetchRequired(new Request(url, {cache: "reload"})));
      }
      if (!await stillSaved()) continue;
      await cache.put(absolute(path), response);
      // A removal may occur while CacheStorage commits the response.
      if (!await stillSaved()) await cache.delete(absolute(path));
    }
  }
  async function install() {
    await cachePages(["/et", "/en"]);
    for (const publicId of await deps.savedPublicIds()) {
      if (validId(publicId)) await cachePages(shellPaths(publicId), publicId, removals.get(publicId) ?? 0);
    }
  }
  async function activate() {
    for (const existing of await deps.caches.keys()) {
      if (existing.startsWith("kontroll-offline-") && existing !== name) await deps.caches.delete(existing);
    }
  }
  function handleFetch(request: Request): Promise<Response> | null {
    const url = new URL(request.url);
    const route = routeRequest(url, deps.origin, request.mode, request.method);
    if (route.kind === "pass") return null;
    return (async () => {
      const cache = await deps.caches.open(name);
      if (route.kind === "static") {
        const assetKey = absolute(url.pathname);
        const cached = await cache.match(assetKey);
        if (cached) return cached;
        const response = await deps.fetch(request);
        if (response.ok && !response.redirected) await cache.put(assetKey, response.clone());
        return response;
      }
      try { return await deps.fetch(request); }
      catch (error) {
        if (route.kind === "report") {
          const shell = await cache.match(absolute(url.pathname));
          if (shell) return shell;
        }
        const front = await cache.match(absolute(`/${route.locale}`));
        if (front) return front;
        throw error;
      }
    })();
  }
  function handleMessage(data: unknown): Promise<{ok: boolean}> {
    if (!data || typeof data !== "object" || !("type" in data) || !("publicId" in data) || !validId(data.publicId) || (data.type !== "cache-shells" && data.type !== "remove-shells")) return Promise.resolve({ok:false});
    const {type, publicId} = data;
    // A removal must finish after any earlier shell fetch, including slow ones.
    const result = messages.then(async () => {
      try {
        if (type === "cache-shells") await cachePages(shellPaths(publicId), publicId, removals.get(publicId) ?? 0);
        else {
          // A delayed removal must not erase a newer save from another tab.
          // The queue ensures an earlier deletion finishes before later caching.
          if ((await deps.savedPublicIds()).includes(publicId)) return {ok:true};
          removals.set(publicId, (removals.get(publicId) ?? 0) + 1);
          const cache = await deps.caches.open(name);
          for (const path of shellPaths(publicId)) await cache.delete(absolute(path));
        }
        return {ok:true};
      } catch { return {ok:false}; }
    });
    messages = result;
    return result;
  }
  return {install, activate, handleFetch, handleMessage};
}
