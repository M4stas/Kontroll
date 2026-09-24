import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const path = "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1";
const source = readFileSync("src/features/offline/service-worker.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function response(body: string, contentType = "text/html") {
  return {
    ok: true,
    headers: { get: (name: string) => name === "content-type" ? contentType : null },
    text: async () => body,
    clone() { return response(body, contentType); },
  };
}

function harness(fetcher: (input: string | { url: string }) => Promise<ReturnType<typeof response>>) {
  const listeners = new Map<string, (event: never) => void>();
  const stores = new Map<string, Map<string, ReturnType<typeof response>>>();
  const cache = (name: string) => {
    let entries = stores.get(name);
    if (!entries) { entries = new Map(); stores.set(name, entries); }
    return {
      keys: async () => [...entries.keys()],
      delete: async (key: string) => entries!.delete(key),
      put: async (key: string | { url: string }, value: ReturnType<typeof response>) => { entries!.set(typeof key === "string" ? key : key.url, value); },
      match: async (key: string | { url: string }) => entries!.get(typeof key === "string" ? key : key.url),
    };
  };
  const caches = { open: async (name: string) => cache(name), delete: async (name: string) => stores.delete(name), keys: async () => [...stores.keys()] };
  vm.runInNewContext(compiled, {
    self: { location: { origin: "https://example.test" }, addEventListener: (type: string, handler: (event: never) => void) => listeners.set(type, handler) },
    caches, fetch: fetcher, URL, Promise, Set, Response: { error: () => ({ ok: false }) },
  });
  const message = (type: string) => {
    let work = Promise.resolve();
    listeners.get("message")?.({
      data: { type, path },
      ports: [{ postMessage: () => undefined }],
      waitUntil: (promise: Promise<void>) => { work = promise; },
    } as never);
    return work;
  };
  const staticFetch = (url: string) => {
    let work = Promise.resolve();
    listeners.get("fetch")?.({
      request: { url, method: "GET" },
      respondWith: (promise: Promise<void>) => { work = promise; },
    } as never);
    return work;
  };
  return { message, staticFetch, cache, stores };
}

describe("service worker clear ordering", () => {
  it("does not restore a shell whose fetch was in flight when clear began", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const worker = harness(async () => {
      entered();
      await gate;
      return response('<main data-report-shell="true"></main>');
    });
    const saving = worker.message("CACHE_REPORT_SHELL");
    await started;
    const clearing = worker.message("CLEAR_REPORT_SHELL");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([saving, clearing]);
    expect(worker.stores.has("kontroll-report-shell-v1")).toBe(false);
  });

  it("does not restore a static asset whose fetch was in flight when clear began", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const worker = harness(async () => {
      entered();
      await gate;
      return response("asset", "text/javascript");
    });
    await worker.cache("kontroll-report-shell-v1").put(path, response("shell"));
    const fetching = worker.staticFetch("https://example.test/_next/static/chunks/report.js");
    await started;
    const clearing = worker.message("CLEAR_REPORT_SHELL");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([fetching, clearing]);
    expect(worker.stores.has("kontroll-report-assets-v1")).toBe(false);
  });

  it("keeps Cache Storage removed when a static asset is requested after clear", async () => {
    const worker = harness(async () => response("asset", "text/javascript"));
    await worker.cache("kontroll-report-shell-v1").put(path, response("shell"));
    await worker.message("CLEAR_REPORT_SHELL");
    await worker.staticFetch("https://example.test/_next/static/chunks/report.js");
    expect(worker.stores.has("kontroll-report-shell-v1")).toBe(false);
    expect(worker.stores.has("kontroll-report-assets-v1")).toBe(false);
  });
});
