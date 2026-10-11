import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("redesign color usage", () => {
  it("uses tokens instead of hex colors in global styles", () => {
    const styles = readFileSync(resolve("src/app/[locale]/globals.css"), "utf8");
    expect(styles.trim()).not.toBe("");
    expect(styles.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it("uses semantic colors instead of green, orange or red TSX utilities", () => {
    const files = tsxFiles(resolve("src"));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(/(?:text|bg)-(?:green|orange|red)-/g);
      return matches ? [{ path, matches }] : [];
    });
    expect(violations).toEqual([]);
  });
});
