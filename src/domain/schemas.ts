import { z } from "zod";
import type {
  Action,
  AnalysisReport,
  ConfidenceInput,
  Evidence,
  Finding,
  SourceSummary,
  VehicleFact,
} from "@/domain/analysis";

const NonEmptyStringSchema = z.string().min(1);
const HttpUrlSchema = z.string().url().regex(/^https?:\/\//i, "Expected an absolute HTTP or HTTPS URL");
// The authenticated PDF endpoint is the only relative source URL in reports.
const SourceUrlSchema = z.union([
  HttpUrlSchema,
  z.string().regex(/^\/api\/analyses\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/background-check\/pdf$/i),
]);
const UnitIntervalSchema = z.number().finite().min(0).max(1);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const VerdictSchema = z.enum(["worth_viewing", "proceed_cautiously", "likely_skip"]);
export const ConfidenceBandSchema = z.enum(["low", "moderate", "high"]);
export const FindingSeveritySchema = z.enum(["critical", "important", "context"]);
export const FindingStateSchema = z.enum(["open", "confirmed", "cleared"]);
export const VerificationStateSchema = z.enum([
  "unverified",
  "corroborated",
  "official",
  "contradicted",
  "not_checked",
]);
export const SourceClassSchema = z.enum([
  "official_registry",
  "manufacturer",
  "independent",
  "forum",
  "listing",
  "seller",
  "buyer",
]);
export const AnalysisStatusSchema = z.enum(["queued", "running", "partial", "complete", "failed"]);
export const LocaleSchema = z.enum(["et", "en"]);
export const ActionKindSchema = z.enum([
  "seller_question",
  "photo_request",
  "document_request",
  "workshop_recommendation",
  "inspection_task",
]);
export const ActionStatusSchema = z.enum(["open", "complete"]);
export const FindingOriginSchema = z.enum(["deterministic", "agent"]);

export const ConfidenceInputSchema: z.ZodType<ConfidenceInput> = z
  .object({
    identity: UnitIntervalSchema,
    coverage: UnitIntervalSchema,
    agreement: UnitIntervalSchema,
    freshness: UnitIntervalSchema,
  })
  .strict();

export const EvidenceSchema: z.ZodType<Evidence> = z
  .object({
    id: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    sourceClass: SourceClassSchema,
    sourceUrl: SourceUrlSchema.optional(),
    imageUrl: z.string().refine(value => {
      if (HttpUrlSchema.safeParse(value).success) return true;
      return /^\/api\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value);
    }, "Invalid image URL").optional(),
    claim: NonEmptyStringSchema,
    applicability: NonEmptyStringSchema,
    confidence: UnitIntervalSchema,
    verification: VerificationStateSchema,
    capturedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.verification === "official" &&
      (evidence.sourceClass === "listing" ||
        evidence.sourceClass === "seller" ||
        evidence.sourceClass === "buyer")
    ) {
      context.addIssue({
        code: "custom",
        message: "Listing, seller, and buyer evidence cannot be official",
        path: ["verification"],
      });
    }
  });

export const VehicleFactSchema: z.ZodType<VehicleFact> = z
  .object({
    key: NonEmptyStringSchema,
    value: NonEmptyStringSchema,
    normalizedValue: NonEmptyStringSchema.optional(),
    sourceId: NonEmptyStringSchema,
    verification: VerificationStateSchema,
    confidence: UnitIntervalSchema,
  })
  .strict();

export const FindingSchema: z.ZodType<Finding> = z
  .object({
    id: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    severity: FindingSeveritySchema,
    state: FindingStateSchema,
    title: NonEmptyStringSchema,
    explanation: NonEmptyStringSchema,
    nextAction: NonEmptyStringSchema,
    evidenceIds: z.array(NonEmptyStringSchema),
    origin: FindingOriginSchema.optional(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.severity !== "context" && finding.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Critical and important findings require evidence",
        path: ["evidenceIds"],
      });
    }
  });

export const ActionSchema: z.ZodType<Action> = z
  .object({
    id: NonEmptyStringSchema,
    kind: ActionKindSchema,
    title: NonEmptyStringSchema,
    instructions: NonEmptyStringSchema,
    status: ActionStatusSchema,
    findingId: NonEmptyStringSchema.optional(),
  })
  .strict();

export const SourceSummarySchema: z.ZodType<SourceSummary> = z
  .object({
    verification: VerificationStateSchema,
    label: NonEmptyStringSchema.optional(),
    url: SourceUrlSchema.optional(),
  })
  .strict();

export const ReviewProgressSchema = z.object({
 backgroundCheck:z.literal("waiting").optional(),
 state:z.enum(['pending','running','incomplete','disabled','complete']),
 text:z.enum(['pending','complete','unavailable']),
 images:z.object({supplied:z.number().int().min(0),selected:z.number().int().min(0),complete:z.number().int().min(0),unavailable:z.number().int().min(0),skipped:z.number().int().min(0),items:z.array(z.object({evidenceId:NonEmptyStringSchema,state:z.enum(["pending","running","complete","unavailable","skipped"])}).strict()).optional()}).strict(),
 final:z.enum(['pending','complete','unavailable']),
}).strict();

export const AnalysisReportSchema: z.ZodType<AnalysisReport> = z
  .object({
    activity: z.object({state:z.enum(["queued","running","stale","stopped"]),leaseExpiresAt:IsoDateTimeSchema.optional(),runId:z.uuid().optional()}).strict().optional(),
    publicId: NonEmptyStringSchema,
    review: ReviewProgressSchema.optional(),
    status: AnalysisStatusSchema,
    locale: LocaleSchema,
    verdict: VerdictSchema.nullable(),
    confidence: ConfidenceBandSchema.nullable(),
    vehicleFacts: z.array(VehicleFactSchema),
    evidence: z.array(EvidenceSchema),
    findings: z.array(FindingSchema),
    actions: z.array(ActionSchema),
    sources: z.record(NonEmptyStringSchema, SourceSummarySchema),
    warnings: z.array(NonEmptyStringSchema),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
