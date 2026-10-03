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

  it.each([
    {
      name: "two confirmed important findings",
      findings: [finding("important", "confirmed"), finding("important", "confirmed")],
      confidence: "high" as const,
      expected: "likely_skip",
    },
    {
      name: "an open critical finding",
      findings: [finding("critical", "open")],
      confidence: "high" as const,
      expected: "proceed_cautiously",
    },
    {
      name: "one confirmed important finding",
      findings: [finding("important", "confirmed")],
      confidence: "high" as const,
      expected: "proceed_cautiously",
    },
    {
      name: "low confidence without findings",
      findings: [],
      confidence: "low" as const,
      expected: "proceed_cautiously",
    },
    {
      name: "moderate confidence without material findings",
      findings: [finding("context", "cleared")],
      confidence: "moderate" as const,
      expected: "worth_viewing",
    },
  ])("returns $expected for $name", ({ findings, confidence, expected }) => {
    expect(calculateVerdict(findings, confidence)).toBe(expected);
  });

  it("applies confirmed critical precedence before the low-confidence fallback", () => {
    expect(calculateVerdict([finding("critical", "confirmed")], "low")).toBe("likely_skip");
  });
});
