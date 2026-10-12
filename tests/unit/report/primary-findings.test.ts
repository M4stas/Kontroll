import { describe, expect, it } from "vitest";
import { selectPrimaryFindings } from "@/features/report/primary-findings";
import { sampleReport } from "../../fixtures/sample-report";

describe("selectPrimaryFindings", () => {
  it("keeps every critical finding", () => {
    const findings = Array.from({ length: 5 }, (_, index) => ({
      ...sampleReport.findings[0]!, id: `critical-${index}`, severity: "critical" as const,
    }));
    expect(selectPrimaryFindings({ ...sampleReport, findings }).map(finding => finding.id))
      .toEqual(["critical-0", "critical-1", "critical-2", "critical-3", "critical-4"]);
  });

  it("keeps at most three findings from distinct groups otherwise", () => {
    const findings = ["identity", "identity", "interior", "mechanical", "mileage"].map((category, index) => ({
      ...sampleReport.findings[0]!, id: `finding-${index}`, category, title: `Check ${index}`,
    }));
    expect(selectPrimaryFindings({ ...sampleReport, findings }).map(finding => finding.id))
      .toEqual(["finding-0", "finding-2", "finding-3"]);
  });

  it("adds a cited photo observation when the first picks cover only documents", () => {
    const photo = { ...sampleReport.evidence[0]!, id: "photo", imageUrl: "/api/analyses/private/images/photo" };
    const findings = ["identity", "mechanical", "mileage"].map((category, index) => ({
      ...sampleReport.findings[0]!, id: `document-${index}`, category, title: `Document check ${index}`,
    }));
    findings.push({ ...sampleReport.findings[0]!, id: "paint", category: "bodywork", severity: "context", title: "Paint marks", explanation: "Marks are visible on the rear panel.", evidenceIds: [photo.id] });
    expect(selectPrimaryFindings({ ...sampleReport, evidence: [...sampleReport.evidence, photo], findings }).map(finding => finding.id))
      .toEqual(["document-0", "document-1", "document-2", "paint"]);
  });

  it("drops duplicate non-critical findings with identical prose", () => {
    const original = { ...sampleReport.findings[0]!, id: "original", category: "identity", title: "VIN needed", explanation: "Ask for the VIN." };
    const findings = [original, { ...original, id: "duplicate" }];
    expect(selectPrimaryFindings({ ...sampleReport, findings }).map(finding => finding.id))
      .toEqual(["original"]);
  });
});
