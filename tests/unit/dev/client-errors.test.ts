import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/dev/client-errors/route";
import { startClientErrorReporting, type ReportingTarget } from "@/lib/client-error-reporting";

function request(body: unknown, origin = "http://kontroll.test") {
  return new Request("http://kontroll.test/api/dev/client-errors", {
    method: "POST",
    headers: { host: "kontroll.test", origin, "content-type": "application/json", "user-agent": "Android Chrome" },
    body: JSON.stringify(body),
  });
}

const report = { kind: "error", message: "TypeError: x is undefined", stack: "at Deck", page: "http://kontroll.test/et" };

describe("client error route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prints a same-origin report in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request(report));
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[client error] http://kontroll.test/et (Android Chrome)\nTypeError: x is undefined\nat Deck"));
    log.mockRestore();
  });

  it("does not exist outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(request(report))).status).toBe(404);
  });

  it("strips page fragments before logging while preserving query values", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ ...report, page: "http://kontroll.test/en/r/id?view=full#access=secret" }));
      expect(response.status).toBe(204);
      expect(log).toHaveBeenCalledWith(`[client error] http://kontroll.test/en/r/id?view=full (Android Chrome)\n${report.message}\n${report.stack}`);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses cross-site fetches even with a matching origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const incoming = request(report);
    incoming.headers.set("sec-fetch-site", "cross-site");
    expect((await POST(incoming)).status).toBe(403);
  });

  it("refuses other origins and malformed reports", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await POST(request(report, "http://evil.test"))).status).toBe(403);
    expect((await POST(request({ ...report, kind: "warn" }))).status).toBe(400);
  });
});

describe("client error reporting", () => {
  it.each(["error", "unhandledrejection", "console.error"])("strips page fragments from %s reports", (kind) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const target = Object.assign(new EventTarget(), {
      fetch,
      console: { error: vi.fn() },
      location: { href: "http://kontroll.test/en/r/id?view=full#access=secret" },
    }) as unknown as ReportingTarget & EventTarget;
    startClientErrorReporting(target);
    if (kind === "console.error") target.console.error("failed");
    else target.dispatchEvent(Object.assign(new Event(kind), { message: "failed", reason: "failed" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      kind,
      page: "http://kontroll.test/en/r/id?view=full",
    });
  });

  it("sends each distinct error once and keeps console.error working", () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const original = vi.fn();
    const target = Object.assign(new EventTarget(), {
      fetch,
      console: { error: original },
      location: { href: "http://kontroll.test/en" },
    }) as unknown as ReportingTarget & EventTarget;
    startClientErrorReporting(target);

    target.console.error("Hydration failed", new Error("mismatch"));
    target.console.error("Hydration failed", new Error("mismatch"));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("lost") }));

    expect(original).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0]).toMatchObject({ kind: "console.error", message: "Hydration failed Error: mismatch", page: "http://kontroll.test/en" });
    expect(bodies[1]).toMatchObject({ kind: "unhandledrejection", message: "Error: lost" });
  });
});
