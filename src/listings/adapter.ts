import type { ListingPhotoPreparation } from "./photos";
import type { ListingJob } from "./contracts";
import type { Listing } from "./contracts";
import { createHash } from "node:crypto";

export type ListingSourceClass = "listing" | "seller" | "buyer";

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

export interface CapturedSourceContent {
  evidenceId: string;
  sourceId: string;
  kind: "listing_fact" | "listing_text" | "buyer_note";
  content: string | Record<string, unknown>;
  verification: "unverified";
}

export interface ListingSnapshot {
  /** Full validated service payload; never interpret year as manufacture year. */
  listing?: Listing;
  photoPreparation?: ListingPhotoPreparation;
  sourceRecords?: CapturedSourceContent[];
  type: "snapshot";
  marketplace: "auto24" | "fallback";
  sourceId: string;
  sourceUrl: string;
  capturedAt: string;
  contentHash: string;
  description: string;
  imageUrls: string[];
  /** Seller-supplied image labels; classification does not verify image contents. */
  inspectionImages?: Array<{ url: string; category: "underside" | "engine_bay" | "instrument_cluster" | "service_document" }>;
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

export interface ListingServiceFailure {
  status: ListingJob["status"];
  code: NonNullable<ListingJob["error"]>["code"] | null;
  submittedAt: string;
  parsedAt: string | null;
  warnings: string[];
}

export interface ListingFallbackRequired {
  serviceFailure?: ListingServiceFailure;
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
