import OpenAI from "openai";
import { z, toJSONSchema } from "zod";
import { LunaInsightProvider } from "@/insights/luna";
import type { NormalizedVehicle } from "@/analysis/normalize";
import type { Evidence, FindingSeverity, SourceClass } from "@/domain/analysis";
import { ActionKindSchema, FindingSeveritySchema, SourceClassSchema } from "@/domain/schemas";
import {
  EVIDENCE_APPLICABILITY_VALUES,
  type EvidenceApplicability,
} from "@/research/source-policy";
import { createInsightImageCapabilityVerifier } from "@/insights/image-capability";

export const INSIGHT_SCHEMA_VERSION = 1;
export const INSIGHT_TIMEOUT_MS = 75_000;

export type InsightWarningCode =
  | "timeout"
  | "refusal"
  | "malformed_response"
  | "schema_invalid"
  | "request_failed"
  | "insufficient_evidence";

export interface InsightWarning {
  stage: "enrich";
  code: InsightWarningCode;
  message: string;
}

export interface InsightSource {
  id: string;
  url: string;
  title: string;
  sourceClass: SourceClass;
  applicability: EvidenceApplicability;
  confidence: number;
  observation: string;
}

export interface InsightRecommendedAction {
  kind: "seller_question" | "photo_request" | "document_request" | "workshop_recommendation" | "inspection_task";
  title: string;
  instructions: string;
}

export interface InsightFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  title: string;
  observation: string;
  source: InsightSource;
  evidenceIds: string[];
  recommendedAction: InsightRecommendedAction;
}

export interface InsightImageObservation {
  imageEvidenceId: string;
  confidence: number;
  observation: string;
  source: InsightSource;
  recommendedAction: InsightRecommendedAction;
}

export interface InsightResult {
  schemaVersion: typeof INSIGHT_SCHEMA_VERSION;
  sources: InsightSource[];
  findings: InsightFinding[];
  imageObservations: InsightImageObservation[];
  warnings: InsightWarning[];
}

export type InsightEvidence = Evidence & {
  text?: string;
  documentText?: string;
  screenshotText?: string;
};

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

export interface InsightInput {
  analysisId: string;
  vehicle: NormalizedVehicle;
  evidence: readonly InsightEvidence[];
  listingText?: string;
  sellerClaims?: readonly string[];
  buyerClaims?: readonly string[];
  documentText?: readonly string[];
  screenshotText?: readonly string[];
  images?: readonly InsightImageInput[];
}

export interface InsightProvider {
  enrich(input: InsightInput): Promise<InsightResult>;
}

export interface InsightEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_INSIGHT_MODEL?: string;
  ANALYSIS_COOKIE_SECRET?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
}

const NonEmptyStringSchema = z.string().min(1);
const UnitIntervalSchema = z.number().finite().min(0).max(1);
const EvidenceApplicabilitySchema = z.enum(EVIDENCE_APPLICABILITY_VALUES);

const InsightWarningSchema: z.ZodType<InsightWarning> = z.object({
  stage: z.literal("enrich"),
  code: z.enum([
    "timeout",
    "refusal",
    "malformed_response",
    "schema_invalid",
    "request_failed",
    "insufficient_evidence",
  ]),
  message: NonEmptyStringSchema,
}).strict();

const InsightSourceSchema: z.ZodType<InsightSource> = z.object({
  id: NonEmptyStringSchema,
  url: z.string().url(),
  title: NonEmptyStringSchema,
  sourceClass: SourceClassSchema,
  applicability: EvidenceApplicabilitySchema,
  confidence: UnitIntervalSchema,
  observation: NonEmptyStringSchema,
}).strict();

const InsightRecommendedActionSchema: z.ZodType<InsightRecommendedAction> = z.object({
  kind: ActionKindSchema,
  title: NonEmptyStringSchema,
  instructions: NonEmptyStringSchema,
}).strict();

const InsightFindingSchema: z.ZodType<InsightFinding> = z.object({
  id: NonEmptyStringSchema,
  category: NonEmptyStringSchema,
  severity: FindingSeveritySchema,
  title: NonEmptyStringSchema,
  observation: NonEmptyStringSchema,
  source: InsightSourceSchema,
  evidenceIds: z.array(NonEmptyStringSchema),
  recommendedAction: InsightRecommendedActionSchema,
}).strict().superRefine((finding, context) => {
  if (finding.severity !== "context" && finding.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidenceIds"],
      message: "Critical and important insight findings require evidence",
    });
  }
});

const InsightImageObservationSchema: z.ZodType<InsightImageObservation> = z.object({
  imageEvidenceId: NonEmptyStringSchema,
  confidence: UnitIntervalSchema,
  observation: NonEmptyStringSchema,
  source: InsightSourceSchema,
  recommendedAction: InsightRecommendedActionSchema,
}).strict();

export const InsightResultSchema: z.ZodType<InsightResult> = z.object({
  schemaVersion: z.literal(INSIGHT_SCHEMA_VERSION),
  sources: z.array(InsightSourceSchema),
  findings: z.array(InsightFindingSchema),
  imageObservations: z.array(InsightImageObservationSchema),
  warnings: z.array(InsightWarningSchema),
}).strict();

export const insightResultJsonSchema = toJSONSchema(InsightResultSchema, {
  target: "draft-07",
});

export function createInsightProvider(
  env: InsightEnvironment,
  imageBoundary?: InsightImageBoundaryOptions,
): InsightProvider | null {
  if (!env.OPENAI_API_KEY || !env.OPENAI_INSIGHT_MODEL) return null;

  const resolvedBoundary = imageBoundary ?? (
    env.ANALYSIS_COOKIE_SECRET && env.NEXT_PUBLIC_SUPABASE_URL
      ? {
        imageUrlVerifier: createInsightImageCapabilityVerifier(env.ANALYSIS_COOKIE_SECRET),
        allowedStorageOrigins: [new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin],
      }
      : {}
  );

  return new LunaInsightProvider(
    new OpenAI({ apiKey: env.OPENAI_API_KEY }),
    env.OPENAI_INSIGHT_MODEL,
    resolvedBoundary,
  );
}
