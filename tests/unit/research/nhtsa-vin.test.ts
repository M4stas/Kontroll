import { describe, expect, it, vi } from "vitest";
import { NhtsaVinResearchProvider } from "@/research/nhtsa-vin";
import type { NormalizedVehicle } from "@/analysis/normalize";

const vehicle = {
  vin: "1HGCM82633A004352", make: "Honda", model: "Accord", year: 2003,
  provenance: { make: [], model: [], year: [], mileageKm: [], fuel: [], transmission: [], vin: [], registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [] },
  conflicts: [],
} satisfies NormalizedVehicle;

describe("NHTSA VIN research", () => {
  it("returns only a decoded identity with exact official provenance", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Results: [{ VIN: vehicle.vin, Make: "HONDA", Model: "Accord", ModelYear: "2003", ErrorCode: "0" }],
    }), { status: 200 }));
    const result = await new NhtsaVinResearchProvider(fetch).research(vehicle);
    expect(result.identity).toEqual({ vin: vehicle.vin, make: "HONDA", model: "Accord", year: 2003 });
    expect(result.sourceRefs).toEqual([expect.objectContaining({ sourceClass: "official_registry", applicability: "exact" })]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/DecodeVinValues/${vehicle.vin}?`), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports unavailable when the decoder gives incomplete or conflicting identity", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Results: [{ VIN: vehicle.vin, Make: "", Model: "", ModelYear: "", ErrorCode: "1" }],
    }), { status: 200 }));
    await expect(new NhtsaVinResearchProvider(fetch).research(vehicle)).rejects.toThrow("VIN research unavailable");
  });
  it("rejects a decoder response that omits the VIN being checked", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Results: [
      { Make: "HONDA", Model: "Accord", ModelYear: "2003", ErrorCode: "0" },
    ] }), { status: 200 }));
    await expect(new NhtsaVinResearchProvider(fetch).research(vehicle)).rejects.toThrow("VIN research unavailable");
  });
});
