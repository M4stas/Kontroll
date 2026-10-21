import { expect, test } from "vitest";
import { routeRequest, staticAssetsIn, shellPaths, cacheName } from "@/service-worker/routing";
const id = "12345678-1234-1234-1234-123456789abc";
const origin = "https://kontroll.test";
const route = (path: string, mode: RequestMode = "navigate", method = "GET") => routeRequest(new URL(path, origin), origin, mode, method);
test("page loads match exact front and report paths", () => {
  expect(route("/en")).toEqual({kind:"front", locale:"en"});
  expect(route("/")).toEqual({kind:"front", locale:"et"});
  expect(route(`/et/r/${id}`)).toEqual({kind:"report", locale:"et", publicId:id});
});
test("other requests pass through", () => {
  for (const path of ["/et/r/not-a-uuid", "/api/analyses/x/report", "/en/", `/en/r/${id}/extra`, "https://other.test/en"])
    expect(route(path)).toEqual({kind:"pass"});
  expect(route("/en", "navigate", "POST")).toEqual({kind:"pass"});
  expect(route("/en", "cors")).toEqual({kind:"pass"});
  expect(route("/_next/static/a.js", "cors", "POST")).toEqual({kind:"pass"});
});
test("GET Next assets are static", () => expect(route("/_next/static/chunks/a.js", "cors")).toEqual({kind:"static"}));
test("extracts unique src and href asset paths without queries", () => {
  expect(staticAssetsIn(`<script src="/_next/static/a.js?v=1"></script><link href='/_next/static/b.css'><script src="/_next/static/a.js"><img src="/photo.jpg">`)).toEqual(["/_next/static/a.js", "/_next/static/b.css"]);
});
test("shell paths and versioned cache name", () => {
  expect(shellPaths(id)).toEqual([`/et/r/${id}`, `/en/r/${id}`]);
  expect(cacheName("abc")).toBe("kontroll-offline-abc");
});
