import { describe, expect, it } from "vitest";
import { calculateVerdict } from "@/domain/verdict";
import type { Finding } from "@/domain/analysis";

const finding = (severity: Finding["severity"], state: Finding["state"]): Finding => ({
  id: crypto.randomUUID(),
  category: "mechanical",
  severity,
  state,
  title: "Example finding",
  explanation: "Evidence-backed test finding.",
  nextAction: "Arrange an inspection.",
  evidenceIds: ["evidence-1"],
});

describe("calculateVerdict", () => {
  it("returns likely_skip for a confirmed critical finding", () => {
    expect(calculateVerdict([finding("critical", "confirmed")], "high")).toBe("likely_skip");
  });

  it("returns proceed_cautiously when important checks remain open", () => {
    expect(calculateVerdict([finding("important", "open")], "moderate")).toBe("proceed_cautiously");
  });

  it("returns worth_viewing when only context findings remain", () => {
    expect(calculateVerdict([finding("context", "open")], "high")).toBe("worth_viewing");
  });
});
