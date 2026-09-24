import { afterEach, describe, expect, it, vi } from "vitest";
import { messageWorker } from "@/features/offline/register-worker";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("messageWorker", () => {
  it("returns when registration fails and readiness never resolves", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: new Promise(() => undefined) },
    });
    const outcome = messageWorker("CLEAR_REPORT_SHELL", "/en/a/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1");
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toBe(false);
  });
});
