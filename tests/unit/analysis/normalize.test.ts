import { describe, expect, it } from "vitest";
import { normalizeVehicle } from "@/analysis/normalize";
import type { ListingSnapshot } from "@/listings/adapter";

function snapshot(facts: ListingSnapshot["facts"]): ListingSnapshot {
  return {
    type: "snapshot",
    marketplace: "auto24",
    sourceId: "listing-snapshot-1",
    sourceUrl: "https://www.auto24.ee/soidukid/123456",
    capturedAt: "2026-09-14T08:00:00.000Z",
    contentHash: "listing-content-001",
    description: "",
    imageUrls: [],
    screenshotRefs: [],
    facts,
    claims: [],
    warnings: [],
  };
}

describe("normalizeVehicle", () => {
  // Catches losing Estonian-format identity values, their canonical forms, or the source that supplied each field.
  it("normalizes Estonian vehicle facts and preserves field-level provenance", () => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "make", value: "Volkswagen", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "model", value: "Passat", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "year", value: "2017", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "mileage", value: "332\u00a0000 km", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "fuel", value: "Diisel", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "gearbox", value: "Automaat", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "vin", value: "wvwmr7an4de000001", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "registration plate", value: "123 abc", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "generation", value: "B8", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "engine", value: "2.0 TDI 140 kW", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "gearbox variant", value: "DSG DQ250", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle).toMatchObject({
      make: "Volkswagen",
      model: "Passat",
      year: 2017,
      mileageKm: 332000,
      fuel: "diesel",
      transmission: "automatic",
      vin: "WVWMR7AN4DE000001",
      registrationPlate: "123 ABC",
      generation: "B8",
      engineVariant: "2.0 TDI 140 kW",
      gearboxVariant: "DSG DQ250",
      provenance: {
        make: ["listing-1"],
        mileageKm: ["listing-1"],
        registrationPlate: ["listing-1"],
      },
      conflicts: [],
    });
  });

  // Catches choosing the first mileage or model when distinct listing facts disagree.
  it("leaves conflicting identity fields unresolved and records both sources", () => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "model", value: "A4", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "model", value: "A6", sourceId: "seller-message-1", verification: "unverified", confidence: 0.5 },
      { key: "mileage", value: "210 000 km", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "mileage", value: "232 000 km", sourceId: "seller-message-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle.model).toBeUndefined();
    expect(vehicle.mileageKm).toBeUndefined();
    expect(vehicle.provenance.model).toEqual(["listing-1", "seller-message-1"]);
    expect(vehicle.provenance.mileageKm).toEqual(["listing-1", "seller-message-1"]);
    expect(vehicle.conflicts).toEqual(expect.arrayContaining([
      {
        field: "model",
        values: [
          { value: "A4", sourceIds: ["listing-1"] },
          { value: "A6", sourceIds: ["seller-message-1"] },
        ],
      },
      {
        field: "mileageKm",
        values: [
          { value: 210000, sourceIds: ["listing-1"] },
          { value: 232000, sourceIds: ["seller-message-1"] },
        ],
      },
    ]));
  });

  // Catches inferring generation or mechanical variants from a make/model title that does not explicitly provide them.
  it("does not infer under-specified generation, engine, or gearbox variants", () => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "make", value: "Toyota", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "model", value: "Avensis", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
      { key: "gearbox", value: "Manuaal", sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle).toMatchObject({
      make: "Toyota",
      model: "Avensis",
      transmission: "manual",
    });
    expect(vehicle.generation).toBeUndefined();
    expect(vehicle.engineVariant).toBeUndefined();
    expect(vehicle.gearboxVariant).toBeUndefined();
  });

  // Catches combining multiple quantities or accepting shorthand that does not identify one supported kilometre value.
  it.each([
    "100 km / 62 mi",
    "210k km",
    "130 000 mi",
  ])("rejects ambiguous or unsupported mileage %s", (mileage) => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "mileage", value: mileage, sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle.mileageKm).toBeUndefined();
    expect(vehicle.provenance.mileageKm).toEqual([]);
  });

  // Catches placeholders and VINs with forbidden letters suppressing the official-identity finding.
  it.each([
    "unknown",
    "N/A",
    "WVWMR7AN4DE00000I",
    "WVWMR7AN4DE0000",
  ])("rejects unusable VIN %s", (vin) => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "vin", value: vin, sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle.vin).toBeUndefined();
    expect(vehicle.provenance.vin).toEqual([]);
  });

  // Catches accepting arbitrary prose as a registration plate or rejecting realistic Estonian car and motorcycle formats.
  it.each([
    ["123 ABC", "123 ABC"],
    ["12 ab", "12 AB"],
    ["CALL SELLER", undefined],
    ["N/A", undefined],
  ] as const)("normalizes only usable Estonian registration plate %s", (plate, expected) => {
    const vehicle = normalizeVehicle(snapshot([
      { key: "registration plate", value: plate, sourceId: "listing-1", verification: "unverified", confidence: 0.5 },
    ]));

    expect(vehicle.registrationPlate).toBe(expected);
  });
});
