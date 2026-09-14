import type { NormalizedVehicle } from "@/analysis/normalize";
import type { SourceClass } from "@/domain/analysis";
import type { ResearchClaimKind } from "@/research/cache-key";

export type ResearchKind = ResearchClaimKind | "identity" | "history" | "maintenance" | "repair_context";
export const EVIDENCE_APPLICABILITY_VALUES = [
  "exact",
  "model",
  "background",
  "needs_confirmation",
  "unverified_input",
] as const;

export type EvidenceApplicability = (typeof EVIDENCE_APPLICABILITY_VALUES)[number];

export interface ResearchSource {
  sourceClass: SourceClass;
  kind: ResearchKind;
  make?: string;
  model?: string;
  generation?: string;
  engine?: string;
  gearbox?: string;
  yearRange?: string;
  vinMatched?: boolean;
}

const ALL_SOURCE_CLASSES: readonly SourceClass[] = [
  "official_registry",
  "manufacturer",
  "independent",
  "forum",
  "listing",
  "seller",
  "buyer",
];

const RANKED_SOURCE_CLASSES: Record<ResearchKind, readonly SourceClass[]> = {
  identity: ["official_registry", "manufacturer", "independent", "forum", "listing", "seller", "buyer"],
  history: ["official_registry", "manufacturer", "independent", "forum", "listing", "seller", "buyer"],
  recall: ["manufacturer", "official_registry", "independent", "forum", "listing", "seller", "buyer"],
  maintenance: ["manufacturer", "official_registry", "independent", "forum", "listing", "seller", "buyer"],
  repair_context: ["independent", "manufacturer", "official_registry", "forum", "listing", "seller", "buyer"],
  common_issue: ["independent", "manufacturer", "official_registry", "forum", "listing", "seller", "buyer"],
};

function sameDimension(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase("en") === right.trim().toLocaleLowerCase("en"));
}

function isUnverifiedInput(sourceClass: SourceClass): boolean {
  return sourceClass === "listing" || sourceClass === "seller" || sourceClass === "buyer";
}

function matchesYearRange(yearRange: string | undefined, year: number | undefined): boolean {
  if (yearRange === undefined) return true;
  if (!Number.isSafeInteger(year)) return false;

  const match = yearRange.trim().match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);
  if (!match) return false;

  const vehicleYear = year as number;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start <= end && vehicleYear >= start && vehicleYear <= end;
}

function matchesSuppliedDimensions(source: ResearchSource, vehicle: NormalizedVehicle): boolean {
  return (!source.make || sameDimension(source.make, vehicle.make))
    && (!source.model || sameDimension(source.model, vehicle.model))
    && (!source.generation || sameDimension(source.generation, vehicle.generation))
    && (!source.engine || sameDimension(source.engine, vehicle.engineVariant))
    && (!source.gearbox || sameDimension(source.gearbox, vehicle.gearboxVariant))
    && matchesYearRange(source.yearRange, vehicle.year);
}

export function rankSources(kind: ResearchKind): readonly SourceClass[] {
  return RANKED_SOURCE_CLASSES[kind] ?? ALL_SOURCE_CLASSES;
}

export function classifyEvidence(source: ResearchSource, vehicle: NormalizedVehicle): EvidenceApplicability {
  if (isUnverifiedInput(source.sourceClass)) return "unverified_input";
  if (source.sourceClass === "forum") return "background";
  if (!matchesSuppliedDimensions(source, vehicle)) return "background";
  if (source.kind === "recall") return source.vinMatched && vehicle.vin ? "exact" : "needs_confirmation";

  if (source.engine) {
    return "exact";
  }
  if (source.gearbox) {
    return "exact";
  }
  if (source.make && source.model) return "model";
  return "background";
}
