import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layout = readFileSync(resolve("src/app/[locale]/layout.tsx"), "utf8");
const styles = readFileSync(resolve("src/app/[locale]/globals.css"), "utf8");

describe("root layout fonts", () => {
  it("imports Geist and Geist Mono from Next.js", () => {
    expect(layout).toMatch(/import\s*\{\s*Geist,\s*Geist_Mono\s*\}\s*from\s*"next\/font\/google"/);
  });

  it("loads extended Latin fonts and declares both color schemes", () => {
    expect(layout).toContain('"latin-ext"');
    expect(layout).toContain('"--font-geist"');
    expect(layout).toContain('"--font-geist-mono"');
    expect(layout).toContain('colorScheme: "light dark"');
  });

  it("replaces Arial in global styles", () => {
    expect(styles).not.toContain("Arial");
  });
});
