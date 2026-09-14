import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedVehicle } from "@/analysis/normalize";
import { buildResearchKey, cacheExpiryAt } from "@/research/cache-key";
import { CachedResearchProvider, type ResearchProvider, type VehicleResearch } from "@/research/provider";
import { ResearchRepository } from "@/server/repositories/research";

function localServiceClient(): SupabaseClient {
  const output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string];
  }));
  const key = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  if (!values.API_URL || !key) throw new Error("Local Supabase service credentials are unavailable");
  return createClient(values.API_URL, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function vehicle(engineVariant = "2.0 TDI 140 kW"): NormalizedVehicle {
  return {
    make: "Volkswagen",
    model: "Passat",
    year: 2017,
    mileageKm: 332000,
    generation: "B8",
    engineVariant,
    gearboxVariant: "DSG DQ250",
    provenance: {} as NormalizedVehicle["provenance"],
    conflicts: [],
  };
}

function research(summary: string): VehicleResearch {
  return {
    summary,
    sourceRefs: [{
      url: "https://example.test/technical-bulletin",
      sourceClass: "independent",
      retrievedAt: "2026-09-14T00:00:00.000Z",
      applicability: "exact",
    }],
  };
}

describe("ResearchRepository-backed cache", () => {
  const now = new Date("2026-09-14T00:00:00.000Z");
  let client: SupabaseClient;
  let repository: ResearchRepository;

  beforeAll(() => {
    client = localServiceClient();
    repository = new ResearchRepository(client);
  });

  beforeEach(async () => {
    const { error } = await client.from("vehicle_research_cache").delete().neq("cache_key", "keep-none");
    expect(error).toBeNull();
  });

  // Catches calling the provider even when a fresh cache row exactly identifies this vehicle and claim kind.
  it("returns a fresh exact row before provider invocation", async () => {
    const key = buildResearchKey(vehicle(), "recall")!;
    await repository.put({
      ...key,
      result: research("cached recall"),
      sourceRefs: research("cached recall").sourceRefs,
      schemaVersion: 1,
      fetchedAt: now.toISOString(),
      expiresAt: cacheExpiryAt("recall", now).toISOString(),
    });
    let calls = 0;
    const upstream: ResearchProvider = { research: async () => { calls += 1; return research("live recall"); } };

    const result = await new CachedResearchProvider(repository, upstream, () => now).research(vehicle(), "recall");

    expect(result).toEqual(research("cached recall"));
    expect(calls).toBe(0);
  });

  // Catches an incompatible cached result shape being returned as a current-schema exact match.
  it("refreshes a fresh row from a different research schema", async () => {
    const key = buildResearchKey(vehicle(), "common_issue")!;
    await repository.put({
      ...key,
      result: research("legacy result"),
      sourceRefs: research("legacy result").sourceRefs,
      schemaVersion: 2,
      fetchedAt: now.toISOString(),
      expiresAt: cacheExpiryAt("common_issue", now).toISOString(),
    });
    let calls = 0;
    const upstream: ResearchProvider = { research: async () => {
      calls += 1;
      return research("current result");
    } };

    await expect(new CachedResearchProvider(repository, upstream, () => now).research(vehicle(), "common_issue"))
      .resolves.toEqual(research("current result"));

    expect(calls).toBe(1);
  });

  // Catches the cache decorator widening the provider's required one-argument contract.
  it("invokes a cache-miss provider with only the normalized vehicle", async () => {
    const calls: unknown[][] = [];
    const upstream: ResearchProvider = { research: async (...args) => {
      calls.push(args);
      return research("fresh result");
    } };

    await new CachedResearchProvider(repository, upstream, () => now).research(vehicle(), "common_issue");

    expect(calls).toEqual([[vehicle()]]);
  });

  // Catches expired rows suppressing fresh provider work or dropping stored source provenance on replacement.
  it("replaces an expired row with normalized result and source provenance", async () => {
    const key = buildResearchKey(vehicle(), "common_issue")!;
    await repository.put({
      ...key,
      result: research("expired"),
      sourceRefs: research("expired").sourceRefs,
      schemaVersion: 1,
      fetchedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-08-30T00:00:00.000Z",
    });
    const upstream: ResearchProvider = { research: async () => research("fresh issue summary") };

    await expect(new CachedResearchProvider(repository, upstream, () => now).research(vehicle(), "common_issue"))
      .resolves.toEqual(research("fresh issue summary"));

    const { data, error } = await client.from("vehicle_research_cache")
      .select("result, source_refs, schema_version, fetched_at, expires_at")
      .eq("cache_key", key.cacheKey)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({
      result: research("fresh issue summary"),
      source_refs: research("fresh issue summary").sourceRefs,
      schema_version: 1,
      fetched_at: "2026-09-14T00:00:00+00:00",
      expires_at: "2026-12-13T00:00:00+00:00",
    });
  });

  // Catches an engine-specific result being reused for a different engine despite shared make, model, and year.
  it("isolates cache entries for distinct exact engine variants", async () => {
    let calls = 0;
    const upstream: ResearchProvider = { research: async (requested) => {
      calls += 1;
      return research(`research for ${requested.engineVariant}`);
    } };
    const cached = new CachedResearchProvider(repository, upstream, () => now);

    await cached.research(vehicle("2.0 TDI 140 kW"), "common_issue");
    await expect(cached.research(vehicle("2.0 TDI 110 kW"), "common_issue"))
      .resolves.toEqual(research("research for 2.0 TDI 110 kW"));

    expect(calls).toBe(2);
  });
});
