import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";

function messageKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];

  return Object.entries(value).flatMap(([key, nested]) =>
    messageKeys(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe("localized messages", () => {
  it("keeps Estonian and English message keys in parity", () => {
    expect(messageKeys(et).sort()).toEqual(messageKeys(en).sort());
  });
});
