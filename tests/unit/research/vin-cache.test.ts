import { describe, expect, it, vi } from "vitest";
import { CachedResearchProvider } from "@/research/provider";
import type { NormalizedVehicle } from "@/analysis/normalize";
import { createWorkerResearchProvider } from "@/research/worker-provider";

const base = {
  make: "Honda", model: "Accord", year: 2003, vin: "1HGCM82633A004352",
  provenance: { make: [], model: [], year: [], mileageKm: [], fuel: [], transmission: [], vin: [], registrationPlate: [], generation: [], engineVariant: [], gearboxVariant: [] },
  conflicts: [],
} satisfies NormalizedVehicle;

describe("VIN scoped research cache", () => {
  it("reuses a decoded VIN without leaking it to another vehicle of the same model", async () => {
    const rows = new Map<string, unknown>();
    const repository = {
      findFresh: vi.fn(async (key: string) => rows.get(key) ?? null),
      put: vi.fn(async (entry: { cacheKey: string }) => { rows.set(entry.cacheKey, entry); }),
    };
    const upstream = { research: vi.fn(async (vehicle: NormalizedVehicle) => ({
      summary: `Decoded ${vehicle.vin}`,
      identity: { vin: vehicle.vin!, make: "HONDA", model: "Accord", year: 2003 },
      sourceRefs: [],
    })) };
    const cached = new CachedResearchProvider(repository as never, upstream, "common_issue", () => new Date("2026-09-25T09:00:00Z"), "vin");
    await cached.research(base);
    await cached.research(base);
    await cached.research({ ...base, vin: "1HGCM82633A004353" });
    expect(upstream.research).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
  });
  it("worker composition uses a bounded VIN decoder and reuses only that VIN's response", async () => {
    const rows = new Map<string, unknown>();
    const repository = {
      findFresh: vi.fn(async (key: string) => rows.get(key) ?? null),
      put: vi.fn(async (entry: { cacheKey: string }) => { rows.set(entry.cacheKey, entry); }),
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Results: [
      { VIN: base.vin, Make: "HONDA", Model: "Accord", ModelYear: "2003", ErrorCode: "0" },
    ] }), { status: 200 }));
    const provider = createWorkerResearchProvider(repository as never, fetch, () => new Date("2026-09-25T09:00:00Z"));
    await provider.research(base);
    await provider.research(base);
    expect(fetch).toHaveBeenCalledOnce();
    expect([...rows.keys()][0]).toContain("vin_decode");
  });
  it("marks VIN research unavailable without an identifier and never makes a network request", async () => {
    const repository = { findFresh: vi.fn(), put: vi.fn() };
    const fetch = vi.fn();
    const provider = createWorkerResearchProvider(repository as never, fetch);
    await expect(provider.research({ ...base, vin: undefined })).rejects.toThrow("VIN research unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.put).not.toHaveBeenCalled();
  });
});
