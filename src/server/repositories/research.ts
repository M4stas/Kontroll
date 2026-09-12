import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResearchCacheEntry<TResult = unknown, TSourceRef = unknown> {
  cacheKey: string;
  make: string;
  model: string;
  generation: string | null;
  engine: string | null;
  gearbox: string | null;
  yearRange: string | null;
  mileageBand: string | null;
  result: TResult;
  sourceRefs: TSourceRef[];
  schemaVersion: number;
  fetchedAt: string;
  expiresAt: string;
}

interface ResearchCacheRow {
  cache_key: string;
  make: string;
  model: string;
  generation: string | null;
  engine: string | null;
  gearbox: string | null;
  year_range: string | null;
  mileage_band: string | null;
  result: unknown;
  source_refs: unknown[];
  schema_version: number;
  fetched_at: string;
  expires_at: string;
}

function mapResearch<TResult, TSourceRef>(row: ResearchCacheRow): ResearchCacheEntry<TResult, TSourceRef> {
  return {
    cacheKey: row.cache_key,
    make: row.make,
    model: row.model,
    generation: row.generation,
    engine: row.engine,
    gearbox: row.gearbox,
    yearRange: row.year_range,
    mileageBand: row.mileage_band,
    result: row.result as TResult,
    sourceRefs: row.source_refs as TSourceRef[],
    schemaVersion: row.schema_version,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

export class ResearchRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findFresh<TResult = unknown, TSourceRef = unknown>(
    cacheKey: string,
    now = new Date(),
  ): Promise<ResearchCacheEntry<TResult, TSourceRef> | null> {
    const { data, error } = await this.client
      .from("vehicle_research_cache")
      .select("*")
      .eq("cache_key", cacheKey)
      .gt("expires_at", now.toISOString())
      .maybeSingle();
    if (error) throw new Error("Could not load vehicle research cache", { cause: error });
    return data ? mapResearch<TResult, TSourceRef>(data as ResearchCacheRow) : null;
  }

  async put<TResult, TSourceRef>(entry: ResearchCacheEntry<TResult, TSourceRef>): Promise<void> {
    const { error } = await this.client.from("vehicle_research_cache").upsert(
      {
        cache_key: entry.cacheKey,
        make: entry.make,
        model: entry.model,
        generation: entry.generation,
        engine: entry.engine,
        gearbox: entry.gearbox,
        year_range: entry.yearRange,
        mileage_band: entry.mileageBand,
        result: entry.result,
        source_refs: entry.sourceRefs,
        schema_version: entry.schemaVersion,
        fetched_at: entry.fetchedAt,
        expires_at: entry.expiresAt,
      },
      { onConflict: "cache_key" },
    );
    if (error) throw new Error("Could not save vehicle research cache", { cause: error });
  }
}
