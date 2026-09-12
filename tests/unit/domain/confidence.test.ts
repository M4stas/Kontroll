import { describe, expect, it } from "vitest";
import { calculateConfidence } from "@/domain/confidence";

describe("calculateConfidence", () => {
  it("keeps confidence low when exact vehicle identity is unresolved", () => {
    expect(calculateConfidence({ identity: 0.45, coverage: 0.9, agreement: 0.9, freshness: 0.9 })).toBe("low");
  });

  it("returns high only when every confidence dimension is strong", () => {
    expect(calculateConfidence({ identity: 0.9, coverage: 0.85, agreement: 0.9, freshness: 0.8 })).toBe("high");
  });

  it.each([
    {
      name: "returns high at the exact 0.8 floor",
      input: { identity: 0.8, coverage: 0.8, agreement: 0.8, freshness: 0.8 },
      expected: "high",
    },
    {
      name: "returns moderate immediately below the high floor",
      input: { identity: 0.799, coverage: 0.9, agreement: 0.9, freshness: 0.9 },
      expected: "moderate",
    },
    {
      name: "returns moderate at the exact 0.55 floor",
      input: { identity: 0.55, coverage: 0.55, agreement: 0.55, freshness: 0.55 },
      expected: "moderate",
    },
    {
      name: "returns low immediately below the moderate floor",
      input: { identity: 0.549, coverage: 0.9, agreement: 0.9, freshness: 0.9 },
      expected: "low",
    },
  ])("$name", ({ input, expected }) => {
    expect(calculateConfidence(input)).toBe(expected);
  });

  it.each([
    { name: "above one", value: 2 },
    { name: "below zero", value: -0.01 },
    { name: "not finite", value: Number.POSITIVE_INFINITY },
    { name: "not a number", value: Number.NaN },
  ])("rejects a $name confidence dimension", ({ value }) => {
    expect(() =>
      calculateConfidence({ identity: value, coverage: 0.8, agreement: 0.8, freshness: 0.8 }),
    ).toThrow();
  });
});
