import { describe, expect, it } from "vitest";
import { assembleReport } from "@/analysis/assemble-report";
import type { Action, Evidence, Finding } from "@/domain/analysis";

const evidence: Evidence = {
  id: "evidence-1",
  sourceId: "listing-1",
  sourceClass: "listing",
  sourceUrl: "https://www.auto24.ee/soidukid/123456",
  claim: "The listing lacks a service invoice.",
  applicability: "Listing statement requiring verification.",
  confidence: 0.5,
  verification: "unverified",
  capturedAt: "2026-09-18T12:00:00.000Z",
};

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "finding-1",
  category: "maintenance",
  severity: "important",
  state: "open",
  title: "Service history needs evidence",
  explanation: "The listing claim is not independently verified.",
  nextAction: "Request the service invoice.",
  evidenceIds: [evidence.id],
  origin: "deterministic",
  ...overrides,
});

const action = (overrides: Partial<Action> = {}): Action => ({
  id: "action-1",
  kind: "document_request",
  title: "Request service invoice",
  instructions: "Ask the seller for dated service invoices.",
  status: "open",
  findingId: "finding-1",
  ...overrides,
});

describe("assembleReport", () => {
  // Catches a severity escalation that reaches a buyer without a persisted evidence reference.
  it("drops critical and important findings that lack supplied evidence", () => {
    const report = assembleReport({
      publicId: "report-1",
      locale: "en",
      status: "partial",
      findings: [finding({ evidenceIds: ["missing-evidence"] })],
      evidence: [],
      updatedAt: "2026-09-18T12:00:00.000Z",
    });

    expect(report.findings).toHaveLength(0);
    expect(report.warnings).toContain("finding_without_evidence");
  });

  // Catches an unavailable official registry being represented as a clean or completed check.
  it("marks an unavailable Transport Administration source as not checked", () => {
    const report = assembleReport({
      publicId: "report-1",
      locale: "en",
      status: "partial",
      findings: [],
      evidence: [],
      sourceStates: { transportAdministration: "unavailable" },
      updatedAt: "2026-09-18T12:00:00.000Z",
    });

    expect(report.sources.transportAdministration?.verification).toBe("not_checked");
  });

  // Catches a normalized duplicate action dropping a distinct finding association.
  it("deduplicates only equal action intents for the same finding", () => {
    const report = assembleReport({
      publicId: "report-1",
      locale: "en",
      status: "partial",
      findings: [finding(), finding({ id: "finding-2", severity: "context", evidenceIds: [] })],
      evidence: [evidence],
      actions: [
        action(),
        action({ id: "action-2", title: "  request  service invoice ", instructions: "ASK THE SELLER FOR DATED SERVICE INVOICES." }),
        action({ id: "action-3", findingId: "finding-2" }),
      ],
      updatedAt: "2026-09-18T12:00:00.000Z",
    });

    expect(report.actions).toHaveLength(2);
    expect(report.actions.map((item) => item.findingId)).toEqual(["finding-1", "finding-2"]);
  });

  // Catches a report assembly path inventing an unapproved confidence score or verdict policy.
  it("uses the established confidence and verdict policies only when confidence input is supplied", () => {
    const report = assembleReport({
      publicId: "report-1",
      locale: "en",
      status: "complete",
      findings: [finding()],
      evidence: [evidence],
      confidenceInput: { identity: 0.8, coverage: 0.8, agreement: 0.8, freshness: 0.8 },
      updatedAt: "2026-09-18T12:00:00.000Z",
    });

    expect(report.confidence).toBe("high");
    expect(report.verdict).toBe("proceed_cautiously");
  });
});
