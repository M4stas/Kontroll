import { createHash } from "node:crypto";

export type ListingSourceClass = "listing" | "buyer";

export interface ListingFact {
  key: string;
  value: string;
  sourceId: string;
  verification: "unverified";
  confidence: number;
}

export interface ListingClaim {
  text: string;
  sourceClass: ListingSourceClass;
  verification: "unverified";
}

export interface ListingSnapshot {
  type: "snapshot";
  marketplace: "auto24" | "fallback";
  sourceId: string;
  sourceUrl: string;
  capturedAt: string;
  contentHash: string;
  description: string;
  imageUrls: string[];
  screenshotRefs: string[];
  facts: ListingFact[];
  claims: ListingClaim[];
  warnings: string[];
}

export type ListingFallbackReason =
  | "fetch_disabled"
  | "unsupported_url"
  | "blocked_response"
  | "missing_required_identity"
  | "fetch_failed";

export interface ListingFallbackRequired {
  type: "fallback_required";
  reason: ListingFallbackReason;
  listingUrl: string;
}

export type ListingCaptureResult = ListingSnapshot | ListingFallbackRequired;

export interface ListingCaptureInput {
  url: URL;
}

export interface FallbackInput {
  originalListingUrl: URL;
  pastedDescription: string;
  screenshotRefs?: string[];
}

export interface ListingAdapter {
  canHandle(url: URL): boolean;
  capture(input: ListingCaptureInput): Promise<ListingCaptureResult>;
}

export function hashRawContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
