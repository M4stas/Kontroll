import type { NormalizedVehicle } from "@/analysis/normalize";

export type ResearchClaimKind = "recall" | "common_issue";

export interface ResearchKey {
  cacheKey: string;
  claimKind: ResearchClaimKind;
  make: string;
  model: string;
  generation: string | null;
  engine: string | null;
  gearbox: string | null;
  yearRange: string;
  mileageBand: string;
}

const MILEAGE_BAND_KM = 50_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function canonical(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function optionalCanonical(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = canonical(value);
  return normalized || null;
}

function mileageBand(mileageKm: number | undefined): string {
  if (!Number.isSafeInteger(mileageKm) || mileageKm === undefined || mileageKm < 0) return "unknown";
  const lower = Math.floor(mileageKm / MILEAGE_BAND_KM) * MILEAGE_BAND_KM;
  return `${lower}-${lower + MILEAGE_BAND_KM - 1}`;
}

export function buildResearchKey(
  vehicle: NormalizedVehicle,
  claimKind: ResearchClaimKind = "common_issue",
): ResearchKey | null {
  if (!vehicle.make || !vehicle.model || !Number.isSafeInteger(vehicle.year)) return null;

  const make = canonical(vehicle.make);
  const model = canonical(vehicle.model);
  if (!make || !model) return null;

  const generation = optionalCanonical(vehicle.generation);
  const engine = optionalCanonical(vehicle.engineVariant);
  const gearbox = optionalCanonical(vehicle.gearboxVariant);
  const yearRange = `${vehicle.year}-${vehicle.year}`;
  const band = mileageBand(vehicle.mileageKm);
  const dimensions = [
    "research",
    "v1",
    claimKind,
    make,
    model,
    generation ?? "none",
    engine ?? "none",
    gearbox ?? "none",
    yearRange,
    band,
  ];

  return {
    cacheKey: dimensions.join(":"),
    claimKind,
    make,
    model,
    generation,
    engine,
    gearbox,
    yearRange,
    mileageBand: band,
  };
}

export function cacheExpiryAt(claimKind: ResearchClaimKind, fetchedAt: Date): Date {
  const ttlDays = claimKind === "recall" ? 30 : 90;
  return new Date(fetchedAt.getTime() + ttlDays * DAY_MS);
}
