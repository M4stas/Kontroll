import type { NormalizedVehicle } from "@/analysis/normalize";
import type { SourceClass } from "@/domain/analysis";
import type { ResearchClaimKind } from "@/research/cache-key";

export type ResearchKind = ResearchClaimKind | "identity" | "history" | "maintenance" | "repair_context";
export type EvidenceApplicability =
  | "exact"
  | "model"
  | "background"
  | "needs_confirmation"
  | "unverified_input";

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

export function rankSources(kind: ResearchKind): readonly SourceClass[] {
  return RANKED_SOURCE_CLASSES[kind] ?? ALL_SOURCE_CLASSES;
}

export function classifyEvidence(source: ResearchSource, vehicle: NormalizedVehicle): EvidenceApplicability {
  if (isUnverifiedInput(source.sourceClass)) return "unverified_input";
  if (source.kind === "recall") return source.vinMatched && vehicle.vin ? "exact" : "needs_confirmation";
  if (source.sourceClass === "forum") return "background";

  if (source.make && !sameDimension(source.make, vehicle.make)) return "background";
  if (source.model && !sameDimension(source.model, vehicle.model)) return "background";
  if (source.engine) {
    if (!vehicle.engineVariant || !sameDimension(source.engine, vehicle.engineVariant)) return "background";
    return "exact";
  }
  if (source.gearbox) {
    if (!vehicle.gearboxVariant || !sameDimension(source.gearbox, vehicle.gearboxVariant)) return "background";
    return "exact";
  }
  if (source.make && source.model) return "model";
  return "background";
}
