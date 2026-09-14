import { describe, expect, it } from "vitest";
import { buildResearchKey, cacheExpiryAt } from "@/research/cache-key";
import type { NormalizedVehicle } from "@/analysis/normalize";

function vehicle(overrides: Partial<NormalizedVehicle> = {}): NormalizedVehicle {
  return {
    make: "Volkswagen",
    model: "Passat",
    year: 2017,
    mileageKm: 332000,
    generation: "B8",
    engineVariant: "2.0 TDI 140 kW",
    gearboxVariant: "DSG DQ250",
    provenance: {} as NormalizedVehicle["provenance"],
    conflicts: [],
    ...overrides,
  };
}

describe("buildResearchKey", () => {
  // Catches cache reuse when required normalized vehicle identity is unresolved.
  it.each([
    { make: undefined },
    { model: undefined },
    { year: undefined },
  ])("returns null without resolved identity %o", (overrides) => {
    expect(buildResearchKey(vehicle(overrides), "recall")).toBeNull();
  });

  // Catches cache fragmentation or unsafe merging from case, whitespace, or omitted mechanical dimensions.
  it("canonicalizes every normalized vehicle dimension into a stable recall key", () => {
    expect(buildResearchKey(vehicle({
      make: "  VOLKSWAGEN ",
      model: "Passat   Alltrack",
      generation: " B8 ",
      engineVariant: " 2.0 TDI 140 kW ",
      gearboxVariant: " DSG DQ250 ",
    }), "recall")).toEqual({
      cacheKey: "research:v1:recall:volkswagen:passat-alltrack:b8:2-0-tdi-140-kw:dsg-dq250:2017-2017:300000-349999",
      claimKind: "recall",
      make: "volkswagen",
      model: "passat-alltrack",
      generation: "b8",
      engine: "2-0-tdi-140-kw",
      gearbox: "dsg-dq250",
      yearRange: "2017-2017",
      mileageBand: "300000-349999",
    });
  });

  // Catches mileage buckets moving at the upper boundary and claim kinds sharing one cache identity.
  it("uses deterministic mileage bands and isolates common-issue entries from recalls", () => {
    expect(buildResearchKey(vehicle({ mileageKm: 350000 }), "common_issue")).toMatchObject({
      cacheKey: "research:v1:common_issue:volkswagen:passat:b8:2-0-tdi-140-kw:dsg-dq250:2017-2017:350000-399999",
      mileageBand: "350000-399999",
    });
    expect(buildResearchKey(vehicle(), "common_issue")?.cacheKey).not.toBe(
      buildResearchKey(vehicle(), "recall")?.cacheKey,
    );
  });
});

describe("cacheExpiryAt", () => {
  // Catches recalls and stable common-issue summaries using the same freshness window.
  it("applies the policy TTL for each claim kind", () => {
    const fetchedAt = new Date("2026-09-14T00:00:00.000Z");

    expect(cacheExpiryAt("recall", fetchedAt).toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(cacheExpiryAt("common_issue", fetchedAt).toISOString()).toBe("2026-12-13T00:00:00.000Z");
  });
});
