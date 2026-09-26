import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("attempts live Auto24 capture when no fetch override is configured", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-key");
  vi.stubEnv("ANALYSIS_COOKIE_SECRET", "local-test-secret-at-least-32-characters");
  vi.stubEnv("WORKER_ID", "worker-test");
  vi.stubEnv("AUTO24_FETCH_ENABLED", undefined);

  const { getServerEnv } = await import("@/config/env");
  expect(getServerEnv().AUTO24_FETCH_ENABLED).toBe(true);
});
