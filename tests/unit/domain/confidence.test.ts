import { describe, expect, it } from "vitest";
import { calculateConfidence } from "@/domain/confidence";

describe("calculateConfidence", () => {
  it("keeps confidence low when exact vehicle identity is unresolved", () => {
    expect(calculateConfidence({ identity: 0.45, coverage: 0.9, agreement: 0.9, freshness: 0.9 })).toBe("low");
  });

  it("returns high only when every confidence dimension is strong", () => {
    expect(calculateConfidence({ identity: 0.9, coverage: 0.85, agreement: 0.9, freshness: 0.8 })).toBe("high");
  });
});
