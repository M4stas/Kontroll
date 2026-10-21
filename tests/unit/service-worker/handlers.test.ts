import { expect, test, vi } from "vitest";
import { createWorkerHandlers } from "@/service-worker/handlers";
const origin = "https://kontroll.test";
const id = "12345678-1234-1234-1234-123456789abc";
function fixture() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (input: RequestInfo | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin).href;
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {match: async (req: RequestInfo) => store.get(key(req))?.clone(), put: async (req: RequestInfo, response: Response) => {store.set(key(req), response.clone());}, delete: async (req: RequestInfo) => store.delete(key(req))};
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  } as unknown as CacheStorage;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<script src="/_next/static/a.js"></script>'));
  const savedPublicIds = vi.fn(async () => [id]);
  const handlers = createWorkerHandlers({caches, fetch:fetcher, origin, buildVersion:"new", savedPublicIds});
  const nav = (path: string) => ({url: origin+path, method:"GET", mode:"navigate"}) as Request;
  return {stores, caches, fetcher, handlers, nav, savedPublicIds};
}
test("offline reports serve shell or locale front", async () => {
  const f = fixture(); await f.handlers.install(); f.fetcher.mockRejectedValue(new Error("offline"));
  expect(await (await f.handlers.handleFetch(f.nav(`/en/r/${id}`)))!.text()).toContain("script");
  expect(await (await f.handlers.handleFetch(f.nav('/en/r/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')))!.text()).toContain("script");
});
test("online report response never enters cache", async () => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response("private report"));
  expect(await (await f.handlers.handleFetch(f.nav(`/et/r/${id}`)))!.text()).toBe("private report");
  expect([...f.stores.values()].every(store => store.size === 0)).toBe(true);
  expect(f.handlers.handleFetch(f.nav('/api/analyses/x/report'))).toBeNull();
});
test("install caches both locales, header shells and assets", async () => {
  const f = fixture(); await f.handlers.install();
  const store = f.stores.get('kontroll-offline-new')!;
  for (const path of ['/et', '/en', `/et/r/${id}`, `/en/r/${id}`, '/_next/static/a.js']) expect(store.has(origin+path)).toBe(true);
  const calls = f.fetcher.mock.calls.map(([req]) => req as Request);
  expect(calls.filter(req => req.url.includes('/r/')).every(req => req.headers.get('x-kontroll-offline-shell') === '1')).toBe(true);
});
test("install rejects failed assets", async () => {
  const f = fixture(); f.fetcher.mockImplementation(async req => new Response(String(req instanceof Request ? req.url : req).includes('/_next/') ? 'failure' : '<script src="/_next/static/a.js">', {status: String(req instanceof Request ? req.url : req).includes('/_next/') ? 500 : 200}));
  await expect(f.handlers.install()).rejects.toThrow();
});
test("activate deletes older scoped caches only", async () => {
  const f = fixture(); await f.caches.open('kontroll-offline-old'); await f.caches.open('other'); await f.caches.open('kontroll-offline-new');
  await f.handlers.activate(); expect(await f.caches.keys()).toEqual(['other','kontroll-offline-new']);
});
test("remove shells removes both locales for only the target", async () => {
  const f = fixture(); await f.handlers.install();
  const otherId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  f.savedPublicIds.mockResolvedValue([id, otherId]);
  expect(await f.handlers.handleMessage({type:'cache-shells', publicId:otherId})).toEqual({ok:true});
  f.savedPublicIds.mockResolvedValue([otherId]);
  expect(await f.handlers.handleMessage({type:'remove-shells', publicId:id})).toEqual({ok:true});
  expect([...f.stores.get('kontroll-offline-new')!.keys()].sort()).toEqual([origin+'/et', origin+'/_next/static/a.js', origin+'/en', origin+`/et/r/${otherId}`, origin+`/en/r/${otherId}`].sort());
  expect(await f.handlers.handleMessage({type:'cache-shells', publicId:'../api'})).toEqual({ok:false});
});

test("messages reject public IDs with URL suffixes", async () => {
  const f = fixture();
  for (const suffix of ['?x=1', '#x', '/..']) expect(await f.handlers.handleMessage({type:'cache-shells', publicId:id+suffix})).toEqual({ok:false});
});
test("cache-shells failure replies false and removal waits for earlier cache work", async () => {
  const f = fixture();
  let release!: () => void;
  f.fetcher.mockImplementationOnce(async () => {await new Promise<void>(resolve => {release=resolve;}); return new Response('shell');});
  const save = f.handlers.handleMessage({type:'cache-shells', publicId:id});
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.savedPublicIds.mockResolvedValue([]);
  const remove = f.handlers.handleMessage({type:'remove-shells', publicId:id});
  release(); await save; await remove;
  expect(f.stores.get('kontroll-offline-new')!.size).toBe(1); // Shared static asset stays cached.
  f.savedPublicIds.mockResolvedValue([id]);
  f.fetcher.mockResolvedValue(new Response('failure', {status:500}));
  expect(await f.handlers.handleMessage({type:'cache-shells', publicId:id})).toEqual({ok:false});
});
test("offline shell and front fallback are distinct, and static hits avoid network", async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async input => new Response((input as Request).url.includes('/r/') ? 'shell' : 'front'));
  await f.handlers.install(); f.fetcher.mockRejectedValue(new Error('offline'));
  expect(await (await f.handlers.handleFetch(f.nav(`/en/r/${id}`)))!.text()).toBe('shell');
  expect(await (await f.handlers.handleFetch(f.nav('/en/r/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')))!.text()).toBe('front');
  expect(await (await f.handlers.handleFetch(f.nav('/')))!.text()).toBe('front');
  f.fetcher.mockResolvedValue(new Response('static'));
  const asset = new Request(origin+'/_next/static/b.js');
  await f.handlers.handleFetch(asset); f.fetcher.mockRejectedValue(new Error('offline'));
  expect(await (await f.handlers.handleFetch(new Request(asset.url+'?v=1')))!.text()).toBe('static');
});

test("removal invalidates a report shell still fetching during installation", async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  f.fetcher.mockImplementation(async input => {
    if ((input as Request).url === origin+`/et/r/${id}`) {
      started(); await new Promise<void>(resolve => release = resolve);
    }
    return new Response("shell");
  });
  const installing = f.handlers.install();
  await ready;
  f.savedPublicIds.mockResolvedValue([]);
  await f.handlers.handleMessage({type:"remove-shells",publicId:id});
  release(); await installing;
  expect([...f.stores.get("kontroll-offline-new")!.keys()].some(url => url.includes("/r/"))).toBe(false);
});
test("installation rechecks saved IDs after a slow shell fetch", async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async input => {
    if ((input as Request).url.includes("/r/")) f.savedPublicIds.mockResolvedValue([]);
    return new Response("shell");
  });
  await f.handlers.install();
  expect([...f.stores.get("kontroll-offline-new")!.keys()].some(url => url.includes("/r/"))).toBe(false);
});

test("a delayed removal preserves a newer same-ID save in the serialized worker", async () => {
 const f=fixture();
 await f.handlers.handleMessage({type:"cache-shells",publicId:id});
 await f.handlers.handleMessage({type:"remove-shells",publicId:id});
 const store=f.stores.get("kontroll-offline-new")!;
 expect(store.has(origin+`/et/r/${id}`)).toBe(true);
 expect(store.has(origin+`/en/r/${id}`)).toBe(true);
});

test("stale removal arriving during a newer cache fetch does not invalidate either locale", async () => {
 const f=fixture();
 let release!: () => void;
 let started!: () => void;
 const ready=new Promise<void>(resolve=>started=resolve);
 f.fetcher.mockImplementationOnce(async ()=>{started();await new Promise<void>(resolve=>release=resolve);return new Response("new shell");});
 const caching=f.handlers.handleMessage({type:"cache-shells",publicId:id});
 await ready;
 const staleRemoval=f.handlers.handleMessage({type:"remove-shells",publicId:id});
 release(); await caching; await staleRemoval;
 const store=f.stores.get("kontroll-offline-new")!;
 expect(store.has(origin+`/et/r/${id}`)).toBe(true);
 expect(store.has(origin+`/en/r/${id}`)).toBe(true);
});
