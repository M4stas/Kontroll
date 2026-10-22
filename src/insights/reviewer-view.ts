import type { ReviewInput } from "./types";

const idKeys = new Set([
  "id", "evidenceId", "evidenceIds", "sourceId", "imageEvidenceId", "executionId", "runId", "analysisId",
]);

const identityKeys = new Set([
  "vin", "vehicleidentificationnumber", "registrationplate", "registrationnumber",
  "registration", "plate", "numberplate", "registreerimisnumber", "regnumber", "regnr",
]);
const isIdentityKey = (key: string) => identityKeys.has(key.toLowerCase().replace(/[\s_-]/g, ""));

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function identityFact(value: unknown): boolean {
  const record = decoded(value);
  return Boolean(record && typeof record === "object" && !Array.isArray(record)
    && Object.entries(record).some(([key, value]) => (key === "key" || key === "field")
      && typeof value === "string" && isIdentityKey(value)));
}

/** Build a detached model view; stored listing and report identity stay intact. */
export function reviewerView(input: ReviewInput) {
  const identities = new Set<string>();
  const remember = (value: unknown) => {
    if (typeof value === "string" && value.trim()) identities.add(value);
  };
  const collect = (raw: unknown): void => {
    const value = decoded(raw);
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (identityFact(record)) {
      remember(record.value);
      if (Array.isArray(record.values)) record.values.forEach(item => {
        if (item && typeof item === "object") remember(item.value);
      });
    }
    for (const [key, item] of Object.entries(record)) {
      if (idKeys.has(key)) continue;
      if (isIdentityKey(key)) remember(item);
      collect(item);
    }
  };
  collect(input);

  // Match the whitespace/hyphen variants accepted by vehicle normalization.
  const identityPatterns = [...identities].map(value => value.replace(/[\s-]/g, ""))
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .map(value => new RegExp("(?<![\\p{L}\\p{N}])" + [...value].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]*") + "(?![\\p{L}\\p{N}])", "giu"));
  const scrub = (raw: unknown): unknown => {
    if (identityFact(raw)) return undefined;
    if (typeof raw === "string") {
      const parsed = decoded(raw);
      if (parsed && typeof parsed === "object") return JSON.stringify(scrub(parsed));
      let text = raw;
      for (const identity of identityPatterns) text = text.replace(identity, "[identity omitted]");
      return text;
    }
    if (Array.isArray(raw)) return raw.map(scrub).filter(item => item !== undefined);
    if (raw && typeof raw === "object") return Object.fromEntries(Object.entries(raw).flatMap(([key, item]) => {
      if (idKeys.has(key)) return [[key, structuredClone(item)]];
      if (isIdentityKey(key)) return [];
      const value = scrub(item);
      return value === undefined ? [] : [[key, value]];
    }));
    return raw;
  };
  // A fact and its citation must disappear together, even if only one encodes its key.
  const omittedEvidence = new Set([
    ...input.sourceRecords.filter(item => identityFact(item.content)).map(item => item.evidenceId),
    ...input.evidence.filter(item => identityFact(item.claim)).map(item => item.id),
  ]);
  const listing = input.listing
    ? Object.fromEntries(Object.entries(input.listing).filter(([key]) => key !== "photo_urls" && key !== "registration"))
    : null;
  return {
    analysisId: input.analysisId,
    runId: input.runId,
    locale: input.locale,
    pass: input.pass,
    vehicle: scrub(input.vehicle),
    listing: scrub(listing),
    sourceRecords: scrub(input.sourceRecords.filter(item => !omittedEvidence.has(item.evidenceId))),
    evidence: scrub(input.evidence.filter(item => !omittedEvidence.has(item.id))),
    ...(input.imageEvidenceId ? { imageEvidenceId: input.imageEvidenceId } : {}),
    ...(input.priorReviews ? { priorReviews: scrub(input.priorReviews) } : {}),
  };
}
