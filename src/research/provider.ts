import type { NormalizedVehicle } from "@/analysis/normalize";
import {
  buildResearchKey,
  cacheExpiryAt,
  type ResearchClaimKind,
  type ResearchKey,
} from "@/research/cache-key";
import type { EvidenceApplicability } from "@/research/source-policy";
import {
  ResearchRepository,
  type ResearchCacheEntry,
} from "@/server/repositories/research";
import type { SourceClass } from "@/domain/analysis";

export const RESEARCH_SCHEMA_VERSION = 1;

export interface ResearchSourceReference {
  url: string;
  sourceClass: SourceClass;
  retrievedAt: string;
  applicability: EvidenceApplicability;
}

export interface VehicleResearch {
  summary: string;
  sourceRefs: ResearchSourceReference[];
}

export interface ResearchProvider {
  research(vehicle: NormalizedVehicle): Promise<VehicleResearch>;
}

function isExactResearchMatch(
  entry: ResearchCacheEntry<VehicleResearch, ResearchSourceReference>,
  key: ResearchKey,
): boolean {
  return entry.cacheKey === key.cacheKey
    && entry.make === key.make
    && entry.model === key.model
    && entry.generation === key.generation
    && entry.engine === key.engine
    && entry.gearbox === key.gearbox
    && entry.yearRange === key.yearRange
    && entry.mileageBand === key.mileageBand
    && entry.schemaVersion === RESEARCH_SCHEMA_VERSION;
}

export class CachedResearchProvider implements ResearchProvider {
  constructor(
    private readonly repository: ResearchRepository,
    private readonly upstream: ResearchProvider,
    private readonly claimKind: ResearchClaimKind = "common_issue",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async research(vehicle: NormalizedVehicle): Promise<VehicleResearch> {
    const key = buildResearchKey(vehicle, this.claimKind);
    if (!key) return this.upstream.research(vehicle);

    const fetchedAt = this.now();
    const cached = await this.repository.findFresh<VehicleResearch, ResearchSourceReference>(
      key.cacheKey,
      fetchedAt,
    );
    if (cached && isExactResearchMatch(cached, key)) return cached.result;

    const result = await this.upstream.research(vehicle);
    await this.repository.put({
      cacheKey: key.cacheKey,
      make: key.make,
      model: key.model,
      generation: key.generation,
      engine: key.engine,
      gearbox: key.gearbox,
      yearRange: key.yearRange,
      mileageBand: key.mileageBand,
      result,
      sourceRefs: result.sourceRefs,
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: cacheExpiryAt(this.claimKind, fetchedAt).toISOString(),
    });
    return result;
  }
}
