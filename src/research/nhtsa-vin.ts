import type { NormalizedVehicle } from "@/analysis/normalize";
import type { ResearchProvider, VehicleResearch } from "@/research/provider";

export class NhtsaVinResearchProvider implements ResearchProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async research(vehicle: NormalizedVehicle): Promise<VehicleResearch> {
    const vin = vehicle.vin;
    if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error("VIN research unavailable");
    const url = new URL(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}`);
    url.searchParams.set("format", "json");
    if (vehicle.year) url.searchParams.set("modelyear", String(vehicle.year));
    const response = await this.fetcher(url.href, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("VIN research unavailable");
    const raw = await response.text();
    if (raw.length > 256_000) throw new Error("VIN research unavailable");
    let item: Record<string, unknown> | undefined;
    try {
      const data = JSON.parse(raw) as { Results?: unknown };
      item = Array.isArray(data.Results) && data.Results.length === 1 && typeof data.Results[0] === "object"
        ? data.Results[0] as Record<string, unknown> : undefined;
    } catch {
      throw new Error("VIN research unavailable");
    }
    const make = typeof item?.Make === "string" ? item.Make.trim() : "";
    const model = typeof item?.Model === "string" ? item.Model.trim() : "";
    const year = Number(item?.ModelYear);
    if (item?.VIN !== vin || item?.ErrorCode !== "0" || !make || !model
      || !Number.isSafeInteger(year) || year < 1981 || year > new Date().getUTCFullYear() + 1) {
      throw new Error("VIN research unavailable");
    }
    return {
      summary: `NHTSA decoded the VIN as ${year} ${make} ${model}; this does not check vehicle history or condition.`,
      identity: { vin, make, model, year },
      sourceRefs: [{ url: url.href, sourceClass: "official_registry", applicability: "exact", retrievedAt: new Date().toISOString() }],
    };
  }
}
