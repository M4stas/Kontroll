import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:3109", browserName: "chromium", serviceWorkers: "allow" },
  webServer: {
    command: "npm run build && npm run start -- --port 3109",
    url: "http://localhost:3109/en",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
