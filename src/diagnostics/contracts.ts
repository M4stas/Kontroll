import { z } from "zod";
import { ActionKindSchema, FindingSeveritySchema } from "@/domain/schemas";
const Id = z.string().min(1).max(128);
const Time = z.iso.datetime({
  offset: true,
});
const Duration = z.number().finite().nonnegative().nullable();
export const PhotoPhaseSchema = z.enum(["capture_prepare", "download", "validation", "normalization", "upload", "capability_verification", "reviewer_prepare", "retrieval", "verification", "png_preparation"]);
export const PhotoSpanSchema = z.object({
  id: Id, evidenceId: Id, parentId: Id.nullable(), phase: PhotoPhaseSchema,
  state: z.enum(["running", "complete", "failed", "incomplete"]), startedAt: Time,
  completedAt: Time.nullable(), durationMs: Duration,
  errorCode: z.enum(["phase_failed", "collection_incomplete"]).nullable(),
  jobAttempt: z.number().int().positive().optional(),
  omittedCount: z.number().int().min(0).max(5000).optional(),
}).strict();
export type PhotoPhase = z.infer<typeof PhotoPhaseSchema>;
export type PhotoSpan = z.infer<typeof PhotoSpanSchema>;
export const DiagnosticStateSchema = z.enum([
  "waiting",
  "running",
  "stale",
  "retrying",
  "complete",
  "failed",
  "unavailable",
  "skipped",
  "reused",
]);
export const ReusedFromSchema = z
  .object({
    runId: Id,
    executionId: Id,
    completedAt: Time.nullable(),
  })
  .strict();
export const DiagnosticAttemptSchema = z
  .object({
    id: Id,
    number: z.number().int().positive(),
    state: z.enum(["started", "success", "failure", "unavailable", "lost", "stale"]),
    startedAt: Time,
    completedAt: Time.nullable(),
    durationMs: Duration,
    warningCode: z.enum(["timeout", "refusal", "invalid_output", "unavailable", "superseded"]).nullable().optional(),
  })
  .strict()
  .refine(
    (x) =>
      (x.state === "started" || x.state === "stale") === (x.completedAt === null) &&
      (x.completedAt === null || Date.parse(x.completedAt) >= Date.parse(x.startedAt)),
  );
export const DiagnosticReviewSchema = z
  .object({
    key: Id,
    executionId: Id.nullable(),
    pass: z.enum(["text", "image", "final"]),
    evidenceId: Id.nullable(),
    selected: z.boolean().default(false),
    state: DiagnosticStateSchema,
    settings: z
      .object({
        provider: z.string().max(64).nullable(),
        model: z.string().max(128).nullable(),
        reasoningEffort: z.string().max(32).nullable(),
        timeoutMs: z.number().int().positive().max(300000).nullable(),
        imageDetail: z.enum(["high", "omitted"]).nullable(),
      })
      .strict()
      .nullable(),
    attempts: z.array(DiagnosticAttemptSchema).max(500),
    latestAttempt: DiagnosticAttemptSchema.nullable().default(null),
    durationMs: Duration,
    resultAvailable: z.boolean(),
    completedAt: Time.nullable(),
    reusedFrom: ReusedFromSchema.nullable(),
  })
  .strict();
export const DiagnosticsSnapshotSchema = z
  .object({
    version: z.literal(1),
    serverNow: Time,
    owner: z
      .object({
        publicId: Id,
        analysisId: Id,
      })
      .strict(),
    currentRunId: Id.nullable(),
    runId: Id.nullable(),
    runs: z
      .array(
        z
          .object({
            id: Id,
            status: z.enum(["queued", "running", "partial", "complete", "failed"]),
            createdAt: Time,
            completedAt: Time.nullable(),
          })
          .strict(),
      )
      .max(1),
    stages: z
      .array(
        z
          .object({
            id: Id,
            stage: z.enum([
              "capture_listing",
              "normalize_identity",
              "baseline_checks",
              "research",
              "enrich",
              "assemble_report",
            ]),
            state: z.enum(["queued", "leased", "complete", "failed", "stale"]),
            leaseExpiresAt: Time.nullable(),
          })
          .strict(),
      )
      .max(32),
    reviews: z.array(DiagnosticReviewSchema).max(258),
    spans: z.array(PhotoSpanSchema).max(500),
    availability: z
      .object({
        review: z.enum(["available", "not_recorded"]),
        internalTimings: z.enum(["available", "partial", "unavailable", "not_recorded"]),
        omittedSpans: z.number().int().nonnegative().optional(),
      })
      .strict(),
    nextCursor: z.string().max(256).nullable(),
    truncated: z.boolean().default(false),
  })
  .strict()
  .refine(
    (x) => new TextEncoder().encode(JSON.stringify(x)).byteLength <= 1048576,
    "Diagnostic payload exceeds budget",
  );
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;
export type DiagnosticReview = z.infer<typeof DiagnosticReviewSchema>;
// Browser-safe result validation; provider validation remains authoritative on the server.
export const DiagnosticsResultSchema = z
  .object({
    executionId: Id,
    runId: Id,
    state: DiagnosticStateSchema,
    reusedFrom: ReusedFromSchema.nullable(),
    result: z
      .object({
        schemaVersion: z.literal(1),
        observations: z
          .array(
            z
              .object({
                id: Id,
                evidenceIds: z.array(Id).max(64),
                category: z.string().min(1).max(100),
                title: z.string().min(1).max(1000),
                severity: FindingSeveritySchema,
                explanation: z.string().min(1).max(20000),
                recommendedAction: z
                  .object({
                    kind: ActionKindSchema,
                    title: z.string().min(1).max(1000),
                    instructions: z.string().min(1).max(20000),
                  })
                  .strict(),
                confidence: z.number().finite().min(0).max(1),
              })
              .strict(),
          )
          .max(64),
        warnings: z.array(z.never()).max(0),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DiagnosticsResult = z.infer<typeof DiagnosticsResultSchema>;
