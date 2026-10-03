import {
  hashRawContent,
  normalizeWhitespace,
  type FallbackInput,
  type ListingSnapshot,
} from "@/listings/adapter";

const INCOMPLETE_FALLBACK_WARNING =
  "Buyer-provided fallback content is unverified; missing fields are not evidence of a clean vehicle.";

export function createFallbackSnapshot(input: FallbackInput): ListingSnapshot {
  const contentHash = hashRawContent(input.pastedDescription);
  const sourceId = `fallback:${contentHash.slice(0, 16)}`;
  const description = normalizeWhitespace(input.pastedDescription);
  const labels: Record<string, string> = {
    mark: "make", make: "make", mudel: "model", model: "model",
    aasta: "year", year: "year", läbisõit: "mileage", mileage: "mileage",
    kütus: "fuel", fuel: "fuel", käigukast: "gearbox", gearbox: "gearbox",
    vin: "vin", registreerimisnumber: "registration plate", "registration plate": "registration plate",
  };
  const facts = input.pastedDescription.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([^:]{2,40}):\s*(.{1,120})\s*$/);
    if (!match) return [];
    const key = labels[match[1]!.trim().toLocaleLowerCase("et")];
    const value = normalizeWhitespace(match[2]!);
    return key && value ? [{ key, value, sourceId, verification: "unverified" as const, confidence: 0.5 }] : [];
  });

  return {
    type: "snapshot",
    marketplace: "fallback",
    sourceId,
    sourceUrl: input.originalListingUrl.href,
    capturedAt: new Date().toISOString(),
    contentHash,
    description,
    imageUrls: [],
    screenshotRefs: input.screenshotRefs ?? [],
    facts,
    claims: description
      ? [{ text: description, sourceClass: "buyer", verification: "unverified" }]
      : [],
    warnings: [INCOMPLETE_FALLBACK_WARNING],
  };
}
