import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {encoding:"utf8"}).trim();
await build({
  entryPoints: ["src/service-worker/sw.ts"],
  bundle: true,
  outfile: "public/sw.js",
  platform: "browser",
  target: "es2020",
  define: {BUILD_VERSION: JSON.stringify(`${commit}-${Date.now()}`)},
});
