import { describe, expect, it } from "vitest";
import {
  ActionSchema,
  ConfidenceInputSchema,
  FindingSchema,
} from "@/domain/schemas";

const finding = {
  id: "finding-1",
  category: "mechanical",
  severity: "important",
  state: "open",
  title: "Service history is incomplete",
  explanation: "The listing does not include supporting invoices.",
  nextAction: "Ask for service invoices.",
  evidenceIds: ["evidence-1"],
} as const;

describe("domain schemas", () => {
  it("rejects unknown object keys", () => {
    expect(() =>
      ActionSchema.parse({
        id: "action-1",
        kind: "seller_question",
        title: "Ask about servicing",
        instructions: "Request dated invoices.",
        status: "open",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects confidence dimensions outside the inclusive zero-to-one range", () => {
    expect(() =>
      ConfidenceInputSchema.parse({
        identity: 1.01,
        coverage: 0.8,
        agreement: 0.8,
        freshness: 0.8,
      }),
    ).toThrow();
    expect(() =>
      ConfidenceInputSchema.parse({
        identity: 0.8,
        coverage: -0.01,
        agreement: 0.8,
        freshness: 0.8,
      }),
    ).toThrow();
  });

  it("requires evidence for critical and important findings", () => {
    expect(() => FindingSchema.parse({ ...finding, evidenceIds: [] })).toThrow();
    expect(() =>
      FindingSchema.parse({ ...finding, severity: "critical", evidenceIds: [] }),
    ).toThrow();
    expect(
      FindingSchema.parse({ ...finding, severity: "context", evidenceIds: [] }),
    ).toMatchObject({ severity: "context", evidenceIds: [] });
  });
});
