import { resolveReviewConfig } from "@/config/review";
import OpenAI from "openai";
import { z, toJSONSchema } from "zod";
import { OpenAIInsightProvider } from "@/insights/luna";
import { ActionKindSchema, EvidenceSchema, FindingSeveritySchema, LocaleSchema, SourceClassSchema } from "@/domain/schemas";
import type { NormalizedVehicle } from "@/analysis/normalize";
import type { Listing } from "@/listings/contracts";
import {
  EVIDENCE_APPLICABILITY_VALUES,
} from "@/research/source-policy";
import { createInsightImageCapabilityVerifier } from "@/insights/image-capability";

export const INSIGHT_SCHEMA_VERSION = 1;
export const INSIGHT_TIMEOUT_MS = 75_000;

export type * from "./types";
import type { CompletedReview, InsightWarning, InsightSource, InsightRecommendedAction, InsightFinding, InsightImageObservation, InsightResult, InsightEnvironment, InsightImageBoundaryOptions, InsightProvider, ReviewInput, ReviewObservation, ReviewResult, ReviewSourceContent, ReviewWarning } from "./types";

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

const REVIEW_SCHEMA_VERSION = 1;
const ReviewPassSchema = z.enum(["text", "image", "final"]);
const ReviewObservationSeveritySchema = FindingSeveritySchema;
const BoundedIdSchema = z.string().min(1).max(128);
const BoundedTextSchema = z.string().max(20_000);
const BoundedShortTextSchema = z.string().min(1).max(4_000);
const ReviewStringValueSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
const ReviewSourceContentValueSchema = z.union([
  z.string().max(20_000),
  z.record(z.string().min(1).max(128), ReviewStringValueSchema).superRefine((record, context) => {
    if (Object.keys(record).length > 64) {
      context.addIssue({ code: "custom", message: "Source content has too many fields" });
    }
  }),
]);
const ReviewSourceContentSchema: z.ZodType<ReviewSourceContent> = z.object({
  evidenceId: BoundedIdSchema,
  sourceId: BoundedIdSchema,
  kind: z.enum(["listing_text", "listing_fact", "seller_reply", "buyer_note", "official_record", "manual_excerpt", "vin_record"]),
  content: ReviewSourceContentValueSchema,
}).strict();

const vehicleFieldNames = ["make", "model", "year", "mileageKm", "fuel", "transmission", "vin", "registrationPlate", "generation", "engineVariant", "gearboxVariant"] as const;
const ReviewVehicleSchema: z.ZodType<NormalizedVehicle> = z.object({
  make: z.string().max(250).optional(),
  model: z.string().max(250).optional(),
  year: z.number().int().min(1800).max(2200).optional(),
  mileageKm: z.number().int().min(0).max(100_000_000).optional(),
  fuel: z.string().max(250).optional(),
  transmission: z.string().max(250).optional(),
  vin: z.string().max(64).optional(),
  registrationPlate: z.string().max(64).optional(),
  generation: z.string().max(250).optional(),
  engineVariant: z.string().max(250).optional(),
  gearboxVariant: z.string().max(250).optional(),
  provenance: z.object(Object.fromEntries(vehicleFieldNames.map((field) => [field, z.array(BoundedIdSchema).max(64)])) as Record<typeof vehicleFieldNames[number], z.ZodArray<typeof BoundedIdSchema>>).strict(),
  conflicts: z.array(z.object({
    field: z.enum(vehicleFieldNames),
    values: z.array(z.object({
      value: z.union([z.string().max(250), z.number().finite()]),
      sourceIds: z.array(BoundedIdSchema).max(64),
    }).strict()).max(32),
  }).strict()).max(32),
}).strict();

const ReviewStringRecordSchema = z.record(z.string().min(1).max(128), z.string().max(2_000)).superRefine((record, context) => {
  if (Object.keys(record).length > 128) context.addIssue({ code: "custom", message: "Listing has too many fields" });
});
const ReviewStringArrayRecordSchema = z.record(z.string().min(1).max(128), z.array(z.string().max(500)).max(128)).superRefine((record, context) => {
  if (Object.keys(record).length > 128) context.addIssue({ code: "custom", message: "Listing has too many equipment groups" });
});
const ReviewListingSchema: z.ZodType<Listing> = z.object({
  source_url: z.string().url().max(2_048),
  listing_id: BoundedIdSchema,
  title: z.string().max(1_000).nullable(),
  make: z.string().max(250).nullable(),
  model: z.string().max(250).nullable(),
  first_registration: z.string().max(100).nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  year_source: z.literal("first_registration").nullable(),
  price: z.object({ amount: z.number().finite().min(0).max(1_000_000_000).nullable(), currency: z.string().max(16).nullable() }).strict().nullable(),
  mileage_km: z.number().int().min(0).max(100_000_000).nullable(),
  body_type: z.string().max(250).nullable(),
  fuel: z.string().max(250).nullable(),
  power_kw: z.number().int().min(0).max(10_000).nullable(),
  gearbox: z.string().max(250).nullable(),
  drivetrain: z.string().max(250).nullable(),
  colour: z.string().max(250).nullable(),
  seller_description: BoundedTextSchema.nullable(),
  seller: z.object({ name: z.string().max(500).nullable(), type: z.string().max(250).nullable(), location: z.string().max(500).nullable() }).strict().nullable(),
  equipment: ReviewStringArrayRecordSchema,
  technical_specs: ReviewStringRecordSchema,
  other_fields: ReviewStringRecordSchema,
  photo_urls: z.array(z.string().url().max(2_048)).max(64),
}).strict().superRefine((listing, context) => {
  if ((listing.year === null) !== (listing.year_source === null)) {
    context.addIssue({ code: "custom", message: "Listing year provenance is inconsistent", path: ["year_source"] });
  }
});

const ReviewEvidenceSchema = EvidenceSchema.superRefine((evidence, context) => {
  if (evidence.id.length > 128 || evidence.sourceId.length > 128 || evidence.claim.length > 4_000 || evidence.applicability.length > 128 || (evidence.sourceUrl?.length ?? 0) > 2_048) {
    context.addIssue({ code: "custom", message: "Evidence exceeds review input bounds" });
  }
});
const ReviewActionSchema = z.object({
  kind: ActionKindSchema,
  title: BoundedShortTextSchema,
  instructions: z.string().min(1).max(20_000),
}).strict();
export const ReviewObservationSchema: z.ZodType<ReviewObservation> = z.object({
  id: BoundedIdSchema,
  evidenceIds: z.array(BoundedIdSchema).max(64),
  category: z.string().min(1).max(100),
  title: BoundedShortTextSchema,
  severity: ReviewObservationSeveritySchema,
  explanation: BoundedTextSchema,
  recommendedAction: ReviewActionSchema,
  confidence: UnitIntervalSchema,
}).strict().superRefine((observation, context) => {
  if (observation.severity !== "context" && observation.evidenceIds.length === 0) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Important observations require evidence" });
  }
  if (new Set(observation.evidenceIds).size !== observation.evidenceIds.length) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "Evidence IDs must be unique" });
  }
});
const ReviewWarningSchema: z.ZodType<ReviewWarning> = z.object({
  code: z.enum(["timeout", "refusal", "invalid_output", "unavailable"]),
  message: z.string().min(1).max(500),
}).strict();
export const ReviewResultSchema: z.ZodType<ReviewResult> = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  observations: z.array(ReviewObservationSchema).max(64),
  warnings: z.array(ReviewWarningSchema).max(16),
}).strict().superRefine((result, context) => {
  const ids = result.observations.map((observation) => observation.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["observations"], message: "Observation IDs must be unique" });
});
export const CompletedReviewSchema: z.ZodType<CompletedReview> = z.object({
  executionId: BoundedIdSchema,
  pass: z.enum(["text", "image"]),
  imageEvidenceId: BoundedIdSchema.optional(),
  result: ReviewResultSchema,
}).strict().superRefine((review, context) => {
  if ((review.pass === "image") !== Boolean(review.imageEvidenceId)) {
    context.addIssue({ code: "custom", path: ["imageEvidenceId"], message: "Only image reviews carry an image evidence ID" });
  }
});
const ReviewCapabilitySchema = z.object({
  version: z.literal(1),
  payload: z.string().min(1).max(16_384),
  signature: z.string().min(1).max(128),
}).strict();
const ReviewImageSchema = z.object({ evidenceId: BoundedIdSchema, capability: ReviewCapabilitySchema }).strict();
export const ReviewInputSchema: z.ZodType<ReviewInput> = z.object({
  analysisId: BoundedIdSchema,
  runId: BoundedIdSchema,
  locale: LocaleSchema,
  pass: ReviewPassSchema,
  imageEvidenceId: BoundedIdSchema.optional(),
  priorReviews: z.array(CompletedReviewSchema).max(65).optional(),
  vehicle: ReviewVehicleSchema,
  listing: ReviewListingSchema.nullable(),
  sourceRecords: z.array(ReviewSourceContentSchema).max(256),
  evidence: z.array(ReviewEvidenceSchema).max(256),
  images: z.array(ReviewImageSchema).max(64),
}).strict().superRefine((input, context) => {
  const evidenceIds = new Set(input.evidence.map((evidence) => evidence.id));
  if (evidenceIds.size !== input.evidence.length) context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be unique" });
  if (input.sourceRecords.some((source) => !evidenceIds.has(source.evidenceId))) context.addIssue({ code: "custom", path: ["sourceRecords"], message: "Source records must belong to supplied evidence" });
  const imageIds = input.images.map((image) => image.evidenceId);
  if (new Set(imageIds).size !== imageIds.length) context.addIssue({ code: "custom", path: ["images"], message: "Image evidence IDs must be unique" });
  if (input.pass === "image") {
    if (!input.imageEvidenceId || imageIds.length !== 1 || imageIds[0] !== input.imageEvidenceId) context.addIssue({ code: "custom", path: ["imageEvidenceId"], message: "Image review requires exactly its selected image" });
  } else if (input.imageEvidenceId || imageIds.length) {
    context.addIssue({ code: "custom", path: ["images"], message: "Text and final reviews cannot receive image capabilities" });
  }
  if (input.pass === "final") {
    if (!input.priorReviews?.length) context.addIssue({ code: "custom", path: ["priorReviews"], message: "Final review requires completed prior reviews" });
  } else if (input.priorReviews) {
    context.addIssue({ code: "custom", path: ["priorReviews"], message: "Only final review receives prior reviews" });
  }
});

export const insightResultJsonSchema = toJSONSchema(InsightResultSchema, {
  target: "draft-07",
});

export function createInsightProvider(
  env: InsightEnvironment,
  imageBoundary?: InsightImageBoundaryOptions,
): InsightProvider | null {
  const config = resolveReviewConfig(env);
  if (config.status !== "enabled" || config.text.status !== "ready") return null;
  const settings = config.text;

  const resolvedBoundary = imageBoundary ?? (
    env.ANALYSIS_COOKIE_SECRET && env.NEXT_PUBLIC_SUPABASE_URL
      ? {
        imageUrlVerifier: createInsightImageCapabilityVerifier(env.ANALYSIS_COOKIE_SECRET),
        allowedStorageOrigins: [new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin],
      }
      : {}
  );

  const adapter = new OpenAIInsightProvider(
    new OpenAI({ apiKey: settings.apiKey }),
    settings.model,
    resolvedBoundary,
    settings.effort,
  );
  return { enrich: input => adapter.enrich({ ...input, images: config.mode === "unified" && config.image.status === "ready" ? input.images : undefined }) };
}

/** The runtime adapter consumes immutable execution settings, never current model defaults. */
export function createDataReviewer(
  pin: import('@/server/repositories/review-executions').ReviewPassPin,
  env: InsightEnvironment,
  imageBoundary: InsightImageBoundaryOptions = {},
  client?: Pick<OpenAI, 'responses'>,
): import('./types').DataReviewer {
  const failed = (code: ReviewWarning['code']): ReviewResult => ({schemaVersion:1,observations:[],warnings:[{code,message:'Review could not be completed.'}]});
  return { async review(rawInput) {
    const parsedInput = ReviewInputSchema.safeParse(rawInput);
    if (!parsedInput.success) return failed('invalid_output');
    const input = parsedInput.data;
    if (pin.availability === 'ready' && pin.provider === 'codex') {
      const { createCodexDataReviewer } = await import('@/insights/codex');
      return createCodexDataReviewer(pin, env, imageBoundary).review(input);
    }
    if (pin.availability !== 'ready' || pin.provider !== 'openai' || !pin.model || !env.OPENAI_API_KEY) return failed('unavailable');
    const { acceptedInsightImages } = await import('@/insights/prompt');
    const accepted = acceptedInsightImages({analysisId:input.analysisId,vehicle:input.vehicle,evidence:input.evidence,images:input.images},imageBoundary);
    if (input.pass === 'image' && (accepted.length !== 1 || accepted[0]?.evidenceId !== input.imageEvidenceId)) return failed('unavailable');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const content={analysisId:input.analysisId,runId:input.runId,locale:input.locale,pass:input.pass,vehicle:input.vehicle,listing:input.listing,sourceRecords:input.sourceRecords,evidence:input.evidence,...(input.imageEvidenceId?{imageEvidenceId:input.imageEvidenceId}:{}),...(input.priorReviews?{priorReviews:input.priorReviews}:{})};
      const response = await Promise.race([
        (client ?? new OpenAI({apiKey:env.OPENAI_API_KEY})).responses.create({model:pin.model,
          ...(pin.reasoningEffort ? {reasoning:{effort:pin.reasoningEffort as import('@/config/review').ReasoningEffort}} : {}),
          input:[{role:'developer',content:[{type:'input_text',text:pin.prompt.content}]},
            {role:'user',content:[{type:'input_text',text:`<UNTRUSTED_REVIEW_INPUT>\n${JSON.stringify(content)}\n</UNTRUSTED_REVIEW_INPUT>`,},
              ...accepted.map(image=>({type:'input_image' as const,image_url:image.signedUrl,detail:'high' as const}))]}],
          text:{format:{type:'json_schema',name:'data_review',strict:true,schema:toJSONSchema(ReviewResultSchema,{target:'draft-07'})}},
        },{signal:controller.signal}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('review_timeout'));},pin.options.timeoutMs);}),
      ]);
      if (response.output?.some(item=>item.type==='message' && item.content.some(value=>value.type==='refusal'))) return failed('refusal');
      const decoded = ReviewResultSchema.safeParse(JSON.parse(response.output_text || 'null'));
      if (!decoded.success) return failed('invalid_output');
      const ids = new Set([...input.evidence.map(evidence=>evidence.id),...accepted.map(image=>image.evidenceId)]);
      if(decoded.data.observations.some(observation=>observation.evidenceIds.some(id=>!ids.has(id))
        || (input.pass==='image' && !observation.evidenceIds.includes(input.imageEvidenceId!)))) return failed('invalid_output');
      return decoded.data;
    } catch(error) {
      if(controller.signal.aborted) return failed('timeout');
      return failed(error instanceof SyntaxError ? 'invalid_output' : 'unavailable');
    } finally {if(timer)clearTimeout(timer);}
  }};
}
