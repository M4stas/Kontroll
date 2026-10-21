import type { NormalizedVehicle } from "@/analysis/normalize";
import type { Evidence } from "@/domain/analysis";
import type { ReviewEnvironment } from "@/config/review";
export interface InsightImageInput {
  evidenceId: string;
  capability: unknown;
}
export interface VerifiedInsightImage {
  evidenceId: string;
  analysisId: string;
  storageKey: string;
  signedUrl: string;
  expiresAt: string;
}
export interface InsightImageUrlVerifier {
  verifyServerIssuedCapability(capability: unknown): VerifiedInsightImage | null;
}
export interface InsightImageBoundaryOptions {
  imageUrlVerifier?: InsightImageUrlVerifier;
  allowedStorageOrigins?: readonly string[];
  now?: () => Date;
}
export interface InsightEnvironment extends ReviewEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_INSIGHT_MODEL?: string;
  ANALYSIS_COOKIE_SECRET?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
}

/** Provider-independent review passes. */
export type ReviewPass = "text" | "image" | "final";

export interface ReviewSourceContent {
  evidenceId: string;
  sourceId: string;
  kind:
    | "listing_text"
    | "listing_fact"
    | "seller_reply"
    | "buyer_note"
    | "official_record"
    | "manual_excerpt"
    | "vin_record";
  content: string | Record<string, unknown>;
}

export interface ReviewImage {
  evidenceId: string;
  /** A short-lived server-issued capability. Never persist this field. */
  capability: unknown;
}

export interface ReviewRecommendedAction {
  kind: import("@/domain/analysis").ActionKind;
  title: string;
  instructions: string;
}

export interface ReviewObservation {
  id: string;
  evidenceIds: string[];
  category: string;
  title: string;
  severity: import("@/domain/analysis").FindingSeverity;
  explanation: string;
  recommendedAction: ReviewRecommendedAction;
  confidence: number;
}

export interface ReviewWarning {
  code: "timeout" | "refusal" | "invalid_output" | "unavailable";
  message: string;
}

export interface ReviewResult {
  schemaVersion: 1;
  observations: ReviewObservation[];
  warnings: ReviewWarning[];
}

export interface CompletedReview {
  executionId: string;
  pass: "text" | "image";
  imageEvidenceId?: string;
  result: ReviewResult;
}

export interface ReviewInput {
  analysisId: string;
  runId: string;
  locale: import("@/domain/analysis").Locale;
  pass: ReviewPass;
  imageEvidenceId?: string;
  priorReviews?: readonly CompletedReview[];
  vehicle: NormalizedVehicle;
  listing: import("@/listings/contracts").Listing | null;
  sourceRecords: readonly ReviewSourceContent[];
  evidence: readonly Evidence[];
  images: readonly ReviewImage[];
}

export interface DataReviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}
