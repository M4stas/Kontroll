import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([".superpowers/**", ".venv/**", ".next/**", "node_modules/**", ".worktrees/**", "playwright-report/**", "test-results/**"]),
]);
