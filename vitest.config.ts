import { readFileSync, globSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const include = ["tests/**/*.test.{ts,tsx}"];
const exclude = ["tests/integration/**", "tests/e2e/**"];

// Sharing one jsdom across files is about 3x faster, but module mocks and global
// stubs leak between files that share a module cache. Files that use them keep
// their own environment.
const leaksAcrossFiles = /\bvi\.(mock|doMock|stubGlobal|stubEnv)\(/;
const isolatedFiles = globSync(include, { exclude })
  .filter((file) => leaksAcrossFiles.test(readFileSync(file, "utf8")));

const shared = {
  environment: "jsdom",
  setupFiles: ["./vitest.setup.ts"],
} as const;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "server-only": new URL("./tests/server-only.ts", import.meta.url).pathname,
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { ...shared, name: "isolated", include: isolatedFiles, exclude },
      },
      {
        extends: true,
        test: { ...shared, name: "shared", include, exclude: [...exclude, ...isolatedFiles], isolate: false },
      },
    ],
  },
});
