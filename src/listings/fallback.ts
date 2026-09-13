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
    facts: [],
    claims: description
      ? [{ text: description, sourceClass: "buyer", verification: "unverified" }]
      : [],
    warnings: [INCOMPLETE_FALLBACK_WARNING],
  };
}
