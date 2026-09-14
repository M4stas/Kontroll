import { describe, expect, it } from "vitest";
import { officialLinksFor, TRANSPORT_ADMINISTRATION_CHECKER_URL } from "@/research/official-links";
import { classifyEvidence, rankSources, type ResearchSource } from "@/research/source-policy";
import type { NormalizedVehicle } from "@/analysis/normalize";

function vehicle(overrides: Partial<NormalizedVehicle> = {}): NormalizedVehicle {
  return {
    make: "Volvo",
    model: "V90",
    year: 2018,
    engineVariant: "D4",
    vin: "YV1PW88A1J1234567",
    provenance: {} as NormalizedVehicle["provenance"],
    conflicts: [],
    ...overrides,
  };
}

describe("classifyEvidence", () => {
  // Catches forum material becoming a vehicle-specific finding from a model-only match.
  it("keeps model-wide forum complaints as background", () => {
    const source: ResearchSource = { sourceClass: "forum", kind: "common_issue", make: "Volvo", model: "V90" };

    expect(classifyEvidence(source, vehicle())).toBe("background");
  });

  // Catches a model-wide manufacturer recall being presented as confirmed without an exact VIN match.
  it("requires an exact VIN match before confirming a recall", () => {
    expect(classifyEvidence({
      sourceClass: "manufacturer",
      kind: "recall",
      vinMatched: false,
    }, vehicle())).toBe("needs_confirmation");
    expect(classifyEvidence({
      sourceClass: "manufacturer",
      kind: "recall",
      vinMatched: true,
    }, vehicle())).toBe("exact");
  });

  // Catches a forum post's asserted VIN match being treated as recall confirmation instead of a lead.
  it("keeps forum recall claims as background even when they assert a VIN match", () => {
    expect(classifyEvidence({
      sourceClass: "forum",
      kind: "recall",
      vinMatched: true,
    }, vehicle())).toBe("background");
  });

  // Catches engine-specific repair material leaking into a request with no exact engine identity.
  it("does not apply engine-specific research without the exact requested engine", () => {
    expect(classifyEvidence({
      sourceClass: "independent",
      kind: "repair_context",
      make: "Volvo",
      model: "V90",
      engine: "D4",
    }, vehicle({ engineVariant: undefined }))).toBe("background");
  });
});

describe("rankSources", () => {
  // Catches source ordering that gives forums or seller claims priority over authoritative sources.
  it("ranks each claim type by its appropriate source", () => {
    expect(rankSources("identity")).toEqual([
      "official_registry", "manufacturer", "independent", "forum", "listing", "seller", "buyer",
    ]);
    expect(rankSources("recall")).toEqual([
      "manufacturer", "official_registry", "independent", "forum", "listing", "seller", "buyer",
    ]);
    expect(rankSources("repair_context")).toEqual([
      "independent", "manufacturer", "official_registry", "forum", "listing", "seller", "buyer",
    ]);
  });
});

describe("officialLinksFor", () => {
  // Catches unavailable official checks being represented as clean or automated through unsupported endpoints.
  it("returns the public MNT checker as not checked", () => {
    expect(officialLinksFor(vehicle()).transportAdministration).toEqual({
      label: "Estonian Transport Administration vehicle background check",
      url: TRANSPORT_ADMINISTRATION_CHECKER_URL,
      verification: "not_checked",
      automation: "manual_only",
    });
  });

  // Catches fabricated manufacturer links and omits regional limitations from a curated official page.
  it("returns only curated official manufacturer links with their regional limitation", () => {
    expect(officialLinksFor(vehicle()).manufacturer).toEqual({
      label: "Volvo recall information",
      url: "https://www.volvocars.com/us/l/recall/",
      verification: "not_checked",
      region: "US",
      regionalLimitation: "This is a US recall page; VIN applicability and local-market coverage require confirmation.",
    });
    expect(officialLinksFor(vehicle({ make: "Saab" })).manufacturer).toBeUndefined();
  });
});
