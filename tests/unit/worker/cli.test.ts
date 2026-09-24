import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("starts the configured worker loop and attempts to lease a job", () => {
  const child = spawnSync("npm", ["run", "worker"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "local-worker-test-key",
      ANALYSIS_COOKIE_SECRET: "local-worker-test-secret-at-least-32-characters",
      AUTO24_FETCH_ENABLED: "false",
      OPENAI_API_KEY: "",
      OPENAI_INSIGHT_MODEL: "",
      WORKER_ID: "worker-entry-test",
    },
    timeout: 10_000,
  });

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("Could not lease analysis job");
});
