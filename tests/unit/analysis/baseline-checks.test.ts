import { describe, expect, it } from "vitest";
import { runBaselineChecks } from "@/analysis/baseline-checks";
import { normalizeVehicle } from "@/analysis/normalize";
import type { ListingSnapshot } from "@/listings/adapter";

function snapshot(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    type: "snapshot",
    marketplace: "auto24",
    sourceId: "listing-snapshot-1",
    sourceUrl: "https://www.auto24.ee/soidukid/123456",
    capturedAt: "2026-09-14T08:00:00.000Z",
    contentHash: "listing-content-001",
    description: "",
    imageUrls: [
      "https://images.auto24.ee/underside.jpg",
      "https://images.auto24.ee/engine-bay.jpg",
      "https://images.auto24.ee/instrument-cluster.jpg",
      "https://images.auto24.ee/service-book.jpg",
    ],
    screenshotRefs: [],
    facts: [
      { key: "make", value: "Volkswagen", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
      { key: "model", value: "Passat", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
      { key: "vin", value: "WVWMR7AN4DE000001", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
      { key: "registration plate", value: "123 ABC", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
    ],
    claims: [],
    warnings: [],
    ...overrides,
  };
}

function rule(result: ReturnType<typeof runBaselineChecks>, category: string) {
  const finding = result.findings.find((candidate) => candidate.category === category);
  if (!finding) throw new Error(`Expected ${category} finding`);
  return finding;
}

describe("runBaselineChecks", () => {
  // Catches treating an unsupported seller maintenance assertion as proof or omitting the invoice request it requires.
  it("turns an unsupported major-service claim into an open important finding with linked evidence", () => {
    const source = snapshot({
      claims: [{ text: "Suur hooldus tehtud", sourceClass: "seller", verification: "unverified" }],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "unsupported_major_maintenance");

    expect(finding).toMatchObject({ severity: "important", state: "open", origin: "deterministic" });
    expect(finding.evidenceIds).toHaveLength(1);
    expect(result.evidence).toContainEqual(expect.objectContaining({
      id: finding.evidenceIds[0],
      sourceId: "listing-snapshot-1",
      sourceClass: "seller",
      claim: "Suur hooldus tehtud",
      verification: "unverified",
    }));
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "document_request", findingId: finding.id }));
  });

  // Catches an automatic vehicle passing baseline checks without a request for its gearbox-service history.
  it("flags missing gearbox service detail for an automatic vehicle", () => {
    const source = snapshot({
      facts: [
        { key: "gearbox", value: "Automaat", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
        { key: "vin", value: "WVWMR7AN4DE000001", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
      ],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "missing_gearbox_service_detail");

    expect(finding).toMatchObject({ severity: "important", state: "open" });
    expect(finding.evidenceIds).toHaveLength(1);
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "seller_question", findingId: finding.id }));
  });

  // Catches a mileage conflict being hidden by normalization instead of becoming an evidence-backed inspection finding.
  it("flags contradictory listing mileage values", () => {
    const source = snapshot({
      facts: [
        { key: "mileage", value: "210 000 km", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
        { key: "mileage", value: "232 000 km", sourceId: "seller-message-1", verification: "unverified", confidence: 0.5 },
        { key: "vin", value: "WVWMR7AN4DE000001", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
      ],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "listing_mileage_disagreement");

    expect(finding).toMatchObject({ severity: "important", state: "open" });
    expect(finding.evidenceIds).toHaveLength(2);
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "inspection_task", findingId: finding.id }));
  });

  // Catches missing both official-check identifiers without an action to obtain one.
  it("flags a listing with neither VIN nor registration plate for official checks", () => {
    const source = snapshot({ facts: [] });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "missing_official_check_identity");

    expect(finding).toMatchObject({ severity: "important", state: "open" });
    expect(result.evidence).toContainEqual(expect.objectContaining({
      id: finding.evidenceIds[0],
      sourceId: "listing-snapshot-1",
      sourceClass: "listing",
      claim: "Listing snapshot has no resolved usable VIN or Estonian registration plate for official checks.",
    }));
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "seller_question", findingId: finding.id }));
  });

  // Catches a listing without inspection-relevant photographs being treated as visually assessable.
  it("flags missing underside, engine-bay, instrument-cluster, and service-document images", () => {
    const source = snapshot({ imageUrls: [] });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "missing_inspection_images");

    expect(finding).toMatchObject({ severity: "important", state: "open" });
    expect(finding.evidenceIds).toHaveLength(1);
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "photo_request", findingId: finding.id }));
  });

  // Catches accepting a no-investment assertion despite the absence of material maintenance evidence.
  it("flags a no-investment description without material maintenance evidence", () => {
    const source = snapshot({
      description: "Auto lisainvesteeringuid ei vaja.",
      imageUrls: [],
      screenshotRefs: [],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "no_investment_without_maintenance_evidence");

    expect(finding).toMatchObject({ severity: "important", state: "open" });
    expect(finding.evidenceIds).toHaveLength(2);
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "document_request", findingId: finding.id }));
  });

  // Catches identical listing content generating colliding persistence IDs for different listing identities.
  it("namespaces deterministic IDs by listing identity as well as content", () => {
    const first = snapshot({
      sourceId: "auto24:listing-1",
      sourceUrl: "https://www.auto24.ee/soidukid/111111",
      claims: [{ text: "Suur hooldus tehtud", sourceClass: "seller", verification: "unverified" }],
    });
    const second = snapshot({
      sourceId: "auto24:listing-2",
      sourceUrl: "https://www.auto24.ee/soidukid/222222",
      claims: [{ text: "Suur hooldus tehtud", sourceClass: "seller", verification: "unverified" }],
    });

    const firstResult = runBaselineChecks(normalizeVehicle(first), first);
    const secondResult = runBaselineChecks(normalizeVehicle(second), second);

    expect(rule(firstResult, "unsupported_major_maintenance").id)
      .not.toBe(rule(secondResult, "unsupported_major_maintenance").id);
    expect(firstResult.evidence[0]?.id).not.toBe(secondResult.evidence[0]?.id);
    expect(firstResult.actions[0]?.id).not.toBe(secondResult.actions[0]?.id);
  });

  // Catches a no-investment finding falsely asserting maintenance evidence is absent when explicit evidence references exist.
  it.each([
    { imageUrls: ["https://images.auto24.ee/service-document.jpg"], screenshotRefs: [] },
    { imageUrls: [], screenshotRefs: ["uploads/listing-screenshot-1.png"] },
  ])("does not assert absent maintenance evidence when the snapshot contains evidence references", (evidenceRefs) => {
    const source = snapshot({
      description: "Auto lisainvesteeringuid ei vaja.",
      ...evidenceRefs,
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);

    expect(result.findings.some((finding) => (
      finding.category === "no_investment_without_maintenance_evidence"
    ))).toBe(false);
  });

  // Catches unresolved conflicting VINs being described as absent instead of retaining both contradiction values as evidence.
  it("links conflicting VIN values when official-check identity cannot be resolved", () => {
    const source = snapshot({
      facts: [
        { key: "vin", value: "WVWMR7AN4DE000001", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 },
        { key: "vin", value: "WVWMR7AN4DE000002", sourceId: "seller-message-1", verification: "unverified", confidence: 0.5 },
      ],
    });
    const vehicle = normalizeVehicle(source);
    const result = runBaselineChecks(vehicle, source);
    const finding = rule(result, "missing_official_check_identity");

    expect(vehicle.vin).toBeUndefined();
    expect(vehicle.conflicts).toContainEqual({
      field: "vin",
      values: [
        { value: "WVWMR7AN4DE000001", sourceIds: ["listing-snapshot-1"] },
        { value: "WVWMR7AN4DE000002", sourceIds: ["seller-message-1"] },
      ],
    });
    expect(finding.explanation).toBe(
      "The listing has conflicting VIN values and no resolved usable VIN or Estonian registration plate for official checks.",
    );
    expect(result.evidence.filter((evidence) => finding.evidenceIds.includes(evidence.id)).map((evidence) => evidence.claim)).toEqual([
      "Conflicting VIN fact: WVWMR7AN4DE000001.",
      "Conflicting VIN fact: WVWMR7AN4DE000002.",
    ]);
  });

  // Catches opaque image and screenshot references being treated as proof of named inspection-photo categories.
  it("describes referenced but unclassified inspection image coverage without asserting category absence", () => {
    const source = snapshot({
      imageUrls: ["https://images.auto24.ee/underside.jpg"],
      screenshotRefs: ["uploads/listing-screenshot-1.png"],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);
    const finding = rule(result, "missing_inspection_images");

    expect(finding.title).toBe("Inspection image coverage is unverified");
    expect(finding.explanation).toBe(
      "The listing snapshot contains image references, but they are not classified as underside, engine-bay, instrument-cluster, or service-document evidence.",
    );
    expect(result.evidence).toContainEqual(expect.objectContaining({
      id: finding.evidenceIds[0],
      claim: "Listing snapshot includes 2 image references, but their required inspection categories are unclassified.",
      verification: "unverified",
    }));
  });

  // Catches any baseline rule upgrading listing or seller assertions into confirmed findings.
  it("never confirms findings from unverified listing or seller claims alone", () => {
    const source = snapshot({
      description: "Auto lisainvesteeringuid ei vaja.",
      claims: [{ text: "Suur hooldus tehtud", sourceClass: "seller", verification: "unverified" }],
      facts: [{ key: "gearbox", value: "Automaat", sourceId: "listing-snapshot-1", verification: "unverified", confidence: 0.5 }],
    });
    const result = runBaselineChecks(normalizeVehicle(source), source);

    expect(result.findings).not.toHaveLength(0);
    expect(result.findings.every((finding) => finding.state !== "confirmed")).toBe(true);
    expect(result.evidence.every((evidence) => evidence.verification === "unverified")).toBe(true);
  });
});
