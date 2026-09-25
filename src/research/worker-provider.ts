import { NhtsaVinResearchProvider } from "@/research/nhtsa-vin";
import { CachedResearchProvider } from "@/research/provider";
import type { ResearchRepository } from "@/server/repositories/research";

/** Identity-only research; no background, recall, fault, or maintenance claims. */
export function createWorkerResearchProvider(
  repository: ResearchRepository,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): CachedResearchProvider {
  return new CachedResearchProvider(repository, new NhtsaVinResearchProvider(fetcher), "vin_decode", now, "vin");
}
