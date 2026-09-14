import { normalizeWhitespace, type ListingFact, type ListingSnapshot } from "@/listings/adapter";

export type NormalizedVehicleField =
  | "make"
  | "model"
  | "year"
  | "mileageKm"
  | "fuel"
  | "transmission"
  | "vin"
  | "registrationPlate"
  | "generation"
  | "engineVariant"
  | "gearboxVariant";

export interface NormalizedFieldValue {
  value: string | number;
  sourceIds: string[];
}

export interface VehicleFieldConflict {
  field: NormalizedVehicleField;
  values: NormalizedFieldValue[];
}

export interface NormalizedVehicle {
  make?: string;
  model?: string;
  year?: number;
  mileageKm?: number;
  fuel?: string;
  transmission?: string;
  vin?: string;
  registrationPlate?: string;
  generation?: string;
  engineVariant?: string;
  gearboxVariant?: string;
  provenance: Record<NormalizedVehicleField, string[]>;
  conflicts: VehicleFieldConflict[];
}

const FIELDS: NormalizedVehicleField[] = [
  "make",
  "model",
  "year",
  "mileageKm",
  "fuel",
  "transmission",
  "vin",
  "registrationPlate",
  "generation",
  "engineVariant",
  "gearboxVariant",
];

const FIELD_KEYS: Record<NormalizedVehicleField, readonly string[]> = {
  make: ["make", "mark", "brand"],
  model: ["model", "mudel"],
  year: ["year", "aasta", "production year"],
  mileageKm: ["mileage", "läbisõit", "odometer"],
  fuel: ["fuel", "kütus", "fuel type"],
  transmission: ["gearbox", "transmission", "käigukast"],
  vin: ["vin", "vehicle identification number"],
  registrationPlate: [
    "registration plate",
    "registration_plate",
    "registration number",
    "registration",
    "plate",
    "number plate",
    "registreerimisnumber",
    "reg number",
    "reg nr",
  ],
  generation: ["generation", "põlvkond"],
  engineVariant: ["engine", "engine variant", "mootor", "engine code"],
  gearboxVariant: ["gearbox variant", "transmission variant", "käigukasti variant"],
};

function normalizedKey(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en");
}

function normalizeYear(value: string): number | undefined {
  const match = normalizeWhitespace(value).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function normalizeMileage(value: string): number | undefined {
  const match = normalizeWhitespace(value).match(/^(\d+(?:[ .]\d{3})*)\s*km$/i);
  if (!match) return undefined;

  const mileage = Number(match[1]?.replace(/[ .]/g, ""));
  return Number.isSafeInteger(mileage) && mileage >= 0 ? mileage : undefined;
}

function normalizeFuel(value: string): string | undefined {
  const normalized = normalizedKey(value);
  const values: Record<string, string> = {
    bensiin: "petrol",
    petrol: "petrol",
    gasoline: "petrol",
    diisel: "diesel",
    diesel: "diesel",
    elekter: "electric",
    electric: "electric",
    hübriid: "hybrid",
    hybrid: "hybrid",
    pistikuhübriid: "plug-in hybrid",
    "plug-in hybrid": "plug-in hybrid",
    gaas: "gas",
    gas: "gas",
  };
  return (values[normalized] ?? normalized) || undefined;
}

function normalizeTransmission(value: string): string | undefined {
  const normalized = normalizedKey(value);
  if (/automaat|automatic/.test(normalized)) return "automatic";
  if (/manuaal|manual/.test(normalized)) return "manual";
  return normalized || undefined;
}

function normalizeVin(value: string): string | undefined {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized)) return undefined;
  return new Set(normalized).size > 1 ? normalized : undefined;
}

function normalizeRegistrationPlate(value: string): string | undefined {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  const plate = compact.match(/^(\d{3}[A-Z]{3}|\d{2}[A-Z]{2}|\d{3,4}[A-Z]{2})$/);
  const parts = plate?.[1]?.match(/^(\d+)([A-Z]+)$/);
  return parts ? `${parts[1]} ${parts[2]}` : undefined;
}

function normalizeField(field: NormalizedVehicleField, value: string): string | number | undefined {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return undefined;

  switch (field) {
    case "year":
      return normalizeYear(normalized);
    case "mileageKm":
      return normalizeMileage(normalized);
    case "fuel":
      return normalizeFuel(normalized);
    case "transmission":
      return normalizeTransmission(normalized);
    case "vin":
      return normalizeVin(normalized);
    case "registrationPlate":
      return normalizeRegistrationPlate(normalized);
    default:
      return normalized;
  }
}

function factsForField(facts: ListingFact[], field: NormalizedVehicleField): ListingFact[] {
  const acceptedKeys = FIELD_KEYS[field];
  return facts.filter((fact) => acceptedKeys.includes(normalizedKey(fact.key)));
}

function resolveField(
  facts: ListingFact[],
  field: NormalizedVehicleField,
): { value?: string | number; provenance: string[]; conflict?: VehicleFieldConflict } {
  const values = new Map<string, NormalizedFieldValue>();

  for (const fact of factsForField(facts, field)) {
    const value = normalizeField(field, fact.value);
    if (value === undefined) continue;

    const key = `${typeof value}:${value}`;
    const existing = values.get(key);
    if (existing) {
      if (!existing.sourceIds.includes(fact.sourceId)) existing.sourceIds.push(fact.sourceId);
    } else {
      values.set(key, { value, sourceIds: [fact.sourceId] });
    }
  }

  const resolvedValues = [...values.values()];
  const provenance = [...new Set(resolvedValues.flatMap((value) => value.sourceIds))];
  if (resolvedValues.length === 1) return { value: resolvedValues[0]?.value, provenance };
  if (resolvedValues.length > 1) return { provenance, conflict: { field, values: resolvedValues } };
  return { provenance };
}

export function normalizeVehicle(snapshot: ListingSnapshot): NormalizedVehicle {
  const provenance: Record<NormalizedVehicleField, string[]> = {
    make: [],
    model: [],
    year: [],
    mileageKm: [],
    fuel: [],
    transmission: [],
    vin: [],
    registrationPlate: [],
    generation: [],
    engineVariant: [],
    gearboxVariant: [],
  };
  const conflicts: VehicleFieldConflict[] = [];
  const resolved = new Map<NormalizedVehicleField, string | number | undefined>();

  for (const field of FIELDS) {
    const result = resolveField(snapshot.facts, field);
    provenance[field] = result.provenance;
    resolved.set(field, result.value);
    if (result.conflict) conflicts.push(result.conflict);
  }

  return {
    make: resolved.get("make") as string | undefined,
    model: resolved.get("model") as string | undefined,
    year: resolved.get("year") as number | undefined,
    mileageKm: resolved.get("mileageKm") as number | undefined,
    fuel: resolved.get("fuel") as string | undefined,
    transmission: resolved.get("transmission") as string | undefined,
    vin: resolved.get("vin") as string | undefined,
    registrationPlate: resolved.get("registrationPlate") as string | undefined,
    generation: resolved.get("generation") as string | undefined,
    engineVariant: resolved.get("engineVariant") as string | undefined,
    gearboxVariant: resolved.get("gearboxVariant") as string | undefined,
    provenance,
    conflicts,
  };
}
