import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Locale, Evidence } from "@/domain/analysis";
import type { NormalizedVehicle } from "@/analysis/normalize";
import type { Listing } from "@/listings/contracts";
import type { ReviewConfig } from "@/config/review";
import { INSIGHT_TIMEOUT_MS, ReviewInputSchema, ReviewResultSchema } from "@/insights/provider";
import { composeReviewPrompt, type ComposedReviewPrompt } from "@/insights/prompt";
import type { ReviewPass, ReviewResult, ReviewSourceContent } from "@/insights/types";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const NonEmpty = z.string().min(1).max(128);

function reviewRpcError(operation: string, cause: unknown): Error & { leaseLost?: true } {
  const message = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : "";
  const lost = [
    "review run is no longer current",
    "review enrich lease is not live or owned by this worker",
    "review attempt lease ownership changed",
    "review enrich lease expired before publication",
  ].includes(message);
  return Object.assign(new Error(operation, { cause }), lost ? { leaseLost: true as const } : {});
}

export interface ReviewLease {
  analysisId: string;
  runId: string;
  jobId: string;
  workerId: string;
}

export interface ReviewPassPin {
  availability: "ready" | "unavailable" | "disabled";
  code?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
  capabilities?: {
    responses: boolean;
    text: boolean;
    structuredOutput: boolean;
    imageInput: boolean;
    efforts: string[];
  };
  options: {
    timeoutMs: number;
    imageDetail: "high" | "omitted";
    outputFormat: "json_schema";
    outputStrict: true;
    outputSchemaVersion: 1;
    maxOutputTokens: null;
    temperature: null;
  };
  prompt: ComposedReviewPrompt;
}

export interface ReviewSnapshotImage {
  evidenceId: string;
  selected: boolean;
  status: "accepted" | "skipped" | "rejected" | "unavailable";
  storageKey?: string;
  contentHash?: string;
  mimeType?: "image/jpeg" | "image/png" | "image/webp";
}

export interface ReviewImageManifest {
  counts: {
    supplied: number;
    selected: number;
    accepted: number;
    skipped: number;
    rejected: number;
    unavailable: number;
  };
  images: ReviewSnapshotImage[];
}

export interface ReviewInputProjection {
  vehicle: NormalizedVehicle;
  listing: Listing | null;
  sourceRecords: readonly ReviewSourceContent[];
  evidence: readonly Evidence[];
}

export interface ReviewRunSnapshotDraft {
  analysisId: string;
  runId: string;
  preparationVersion: number;
  schemaVersion: number;
  locale: Locale;
  mode: "unified" | "split" | "disabled" | "unavailable";
  input: ReviewInputProjection;
  imageManifest: ReviewImageManifest;
  passes: Record<ReviewPass, ReviewPassPin>;
}

export interface ReviewRunSnapshot extends ReviewRunSnapshotDraft {
  id: string;
  inputHash: string;
  createdAt: string;
}

export interface ReviewExecutionDescriptor {
  input: import("@/insights/types").ReviewInput;
}

export interface ReviewExecutionRecord {
  id: string;
  analysisId: string;
  runId: string;
  snapshotId: string;
  pass: ReviewPass;
  imageEvidenceId: string | null;
  fingerprint: string;
  evidenceIds: string[];
  priorExecutionIds: string[];
  priorResultHashes: Array<{ executionId: string; resultHash: string }>;
  result: ReviewResult | null;
  resultHash: string | null;
  completedAt: string | null;
}

export interface ReviewAttemptRecord {
  id: string;
  attemptNumber: number;
}

export interface ReviewPublication {
  assemblyResult: unknown;
  status: "partial" | "complete" | "failed";
  verdict: string | null;
  confidence: string | null;
  completedAt: string;
  findings: unknown[];
  actions: unknown[];
}

const PassPinSchema = z
  .object({
    availability: z.enum(["ready", "unavailable", "disabled"]),
    code: z.string().regex(SAFE_CODE_PATTERN).optional(),
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
    reasoningEffort: z.string().max(32).nullable().optional(),
    capabilities: z
      .object({
        responses: z.boolean(),
        text: z.boolean(),
        structuredOutput: z.boolean(),
        imageInput: z.boolean(),
        efforts: z.array(z.string().max(32)).max(16),
      })
      .strict()
      .optional(),
    options: z
      .object({
        timeoutMs: z.number().int().min(1).max(300_000),
        imageDetail: z.enum(["high", "omitted"]),
        outputFormat: z.literal("json_schema"),
        outputStrict: z.literal(true),
        outputSchemaVersion: z.literal(1),
        maxOutputTokens: z.null(),
        temperature: z.null(),
      })
      .strict(),
    prompt: z.object({ content: z.string().min(1).max(65_536), hash: z.string().regex(HASH_PATTERN) }).strict(),
  })
  .strict()
  .superRefine((pin, context) => {
    if (pin.availability === "ready" && (!pin.provider || !pin.model || !pin.capabilities)) {
      context.addIssue({ code: "custom", message: "Ready review settings require provider, model, and capabilities" });
    }
  });

const ImageManifestSchema = z
  .object({
    counts: z
      .object({
        supplied: z.number().int().min(0).max(256),
        selected: z.number().int().min(0).max(64),
        accepted: z.number().int().min(0).max(64),
        skipped: z.number().int().min(0).max(256),
        rejected: z.number().int().min(0).max(256),
        unavailable: z.number().int().min(0).max(256),
      })
      .strict(),
    images: z
      .array(
        z
          .object({
            evidenceId: NonEmpty,
            selected: z.boolean(),
            status: z.enum(["accepted", "skipped", "rejected", "unavailable"]),
            storageKey: z.string().min(1).max(512).optional(),
            contentHash: z.string().regex(HASH_PATTERN).optional(),
            mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

const SnapshotSchema = z
  .object({
    analysisId: NonEmpty,
    runId: NonEmpty,
    preparationVersion: z.number().int().positive().max(1000),
    schemaVersion: z.number().int().positive().max(1000),
    locale: z.enum(["et", "en"]),
    mode: z.enum(["unified", "split", "disabled", "unavailable"]),
    input: z
      .object({
        vehicle: z.unknown(),
        listing: z.unknown().nullable(),
        sourceRecords: z.array(z.unknown()).max(256),
        evidence: z.array(z.unknown()).max(256),
      })
      .strict(),
    imageManifest: ImageManifestSchema,
    passes: z.object({ text: PassPinSchema, image: PassPinSchema, final: PassPinSchema }).strict(),
  })
  .strict();

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalReviewJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new Error("Review audit value is not JSON serializable");
  return encoded;
}

function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function cleanAuditString(raw: string): string {
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted-key]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      const trailing = value.match(/[),.;!?]+$/)?.[0] ?? "";
      return cleanUrl(trailing ? value.slice(0, -trailing.length) : value) + trailing;
    });
}

const SENSITIVE_KEY =
  /(?:api.?key|credential|access.?token|capability|signed.?url|authorization|bearer|signature|token)/i;

export function sanitizeReviewAuditValue(value: unknown): unknown {
  if (typeof value === "string") return cleanAuditString(value);
  if (Array.isArray(value)) return value.map(sanitizeReviewAuditValue);
  if (value && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((key !== "maxOutputTokens" && SENSITIVE_KEY.test(key)) || entry === undefined) continue;
      safe[key] = sanitizeReviewAuditValue(entry);
    }
    return safe;
  }
  return value;
}

function verifyImageManifest(analysisId: string, manifest: ReviewImageManifest): void {
  const parsed = ImageManifestSchema.parse(manifest);
  const { counts, images } = parsed;
  const observed = {
    supplied: images.length,
    selected: images.filter((image) => image.selected).length,
    accepted: images.filter((image) => image.status === "accepted").length,
    skipped: images.filter((image) => image.status === "skipped").length,
    rejected: images.filter((image) => image.status === "rejected").length,
    unavailable: images.filter((image) => image.status === "unavailable").length,
  };
  if (canonicalReviewJson(observed) !== canonicalReviewJson(counts))
    throw new Error("Review image manifest counts do not match its entries");
  if (new Set(images.map((image) => image.evidenceId)).size !== images.length)
    throw new Error("Review image evidence IDs must be unique");
  for (const image of images) {
    if (image.status === "accepted" && !image.selected) throw new Error("Only selected images may be accepted");
    if (image.selected && image.status === "skipped") throw new Error("A selected image cannot be skipped");
    if (image.status === "accepted") {
      if (!image.storageKey?.startsWith(`${analysisId}/`) || !image.contentHash || !image.mimeType) {
        throw new Error("Accepted images require an analysis-owned storage key, byte hash, and MIME type");
      }
    }
    if (
      image.storageKey &&
      (!image.storageKey.startsWith(`${analysisId}/`) || image.storageKey.length <= analysisId.length + 1)
    ) {
      throw new Error("Review image storage key must belong to its analysis");
    }
  }
}

function safeInputProjection(draft: ReviewRunSnapshotDraft): ReviewInputProjection {
  const candidate = sanitizeReviewAuditValue(draft.input) as ReviewInputProjection;
  const validated = ReviewInputSchema.parse({
    analysisId: draft.analysisId,
    runId: draft.runId,
    locale: draft.locale,
    pass: "text",
    vehicle: candidate.vehicle,
    listing: candidate.listing,
    sourceRecords: candidate.sourceRecords,
    evidence: candidate.evidence,
    images: [],
  });
  return {
    vehicle: validated.vehicle,
    listing: validated.listing,
    sourceRecords: validated.sourceRecords,
    evidence: validated.evidence,
  };
}

export function createReviewPassPins(
  config: ReviewConfig,
  locale: Locale,
): { mode: ReviewRunSnapshotDraft["mode"]; passes: Record<ReviewPass, ReviewPassPin> } {
  const prompts = {
    text: composeReviewPrompt("text", locale),
    image: composeReviewPrompt("image", locale),
    final: composeReviewPrompt("final", locale),
  };
  const mode =
    config.status === "disabled" ? "disabled" : config.status === "unavailable" ? "unavailable" : config.mode;
  const build = (pass: ReviewPass): ReviewPassPin => {
    const prompt = prompts[pass];
    const options: ReviewPassPin["options"] = {
      timeoutMs:
        config.status === "enabled" && config[pass].status === "ready" && config[pass].provider === "codex"
          ? config[pass].effort === "max"
            ? 300_000
            : 120_000
          : INSIGHT_TIMEOUT_MS,
      imageDetail: pass === "image" ? "high" : "omitted",
      outputFormat: "json_schema",
      outputStrict: true,
      outputSchemaVersion: 1,
      maxOutputTokens: null,
      temperature: null,
    };
    if (config.status === "disabled") return { availability: "disabled", options, prompt };
    if (config.status === "unavailable") return { availability: "unavailable", code: config.code, options, prompt };
    const settings = config[pass];
    if (settings.status === "unavailable") return { availability: "unavailable", code: settings.code, options, prompt };
    return {
      availability: "ready",
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.effort ?? null,
      capabilities: {
        responses: settings.capabilities.responses,
        text: settings.capabilities.text,
        structuredOutput: settings.capabilities.structuredOutput,
        imageInput: settings.capabilities.imageInput,
        efforts: [...settings.capabilities.efforts],
      },
      options,
      prompt,
    };
  };
  return { mode, passes: { text: build("text"), image: build("image"), final: build("final") } };
}

export function reviewSnapshotInputHash(input: {
  analysisId: string;
  runId: string;
  preparationVersion: number;
  schemaVersion: number;
  locale: Locale;
  projection: ReviewInputProjection;
  imageManifest: ReviewImageManifest;
}): string {
  return hash(
    canonicalReviewJson({
      analysisId: input.analysisId,
      runId: input.runId,
      preparationVersion: input.preparationVersion,
      schemaVersion: input.schemaVersion,
      locale: input.locale,
      input: input.projection,
      imageManifest: input.imageManifest,
    }),
  );
}

function validateDraft(draft: ReviewRunSnapshotDraft): ReviewRunSnapshotDraft {
  const sanitized = sanitizeReviewAuditValue(draft);
  const parsed = SnapshotSchema.parse(sanitized) as ReviewRunSnapshotDraft;
  parsed.input = safeInputProjection(parsed);
  verifyImageManifest(parsed.analysisId, parsed.imageManifest);
  if (
    parsed.passes.text.prompt.hash !== hash(parsed.passes.text.prompt.content) ||
    parsed.passes.image.prompt.hash !== hash(parsed.passes.image.prompt.content) ||
    parsed.passes.final.prompt.hash !== hash(parsed.passes.final.prompt.content)
  ) {
    throw new Error("Pinned prompt content does not match its SHA-256 hash");
  }
  if (canonicalReviewJson(parsed).length > 2_000_000)
    throw new Error("Review run snapshot exceeds the audit size limit");
  return parsed;
}

function reviewInputProjection(input: import("@/insights/types").ReviewInput): Record<string, unknown> {
  return {
    locale: input.locale,
    pass: input.pass,
    ...(input.imageEvidenceId ? { imageEvidenceId: input.imageEvidenceId } : {}),
    vehicle: input.vehicle,
    listing: input.listing,
    sourceRecords: input.sourceRecords,
    evidence: input.evidence,
    imageEvidenceIds: input.images.map((image) => image.evidenceId),
    ...(input.priorReviews ? { priorReviews: input.priorReviews } : {}),
  };
}

function mapExecution(row: Record<string, unknown>): ReviewExecutionRecord {
  const parsedResult = row.result === null ? null : ReviewResultSchema.parse(row.result);
  return {
    id: row.id as string,
    analysisId: row.analysis_id as string,
    runId: row.run_id as string,
    snapshotId: row.snapshot_id as string,
    pass: row.pass as ReviewPass,
    imageEvidenceId: row.image_evidence_id as string | null,
    fingerprint: row.fingerprint as string,
    evidenceIds: row.evidence_ids as string[],
    priorExecutionIds: row.prior_execution_ids as string[],
    priorResultHashes: row.prior_result_hashes as Array<{ executionId: string; resultHash: string }>,
    result: parsedResult,
    resultHash: row.result_hash as string | null,
    completedAt: row.completed_at as string | null,
  };
}

export class ReviewExecutionsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async pinRunSnapshot(lease: ReviewLease, draft: ReviewRunSnapshotDraft): Promise<ReviewRunSnapshot> {
    if (draft.analysisId !== lease.analysisId || draft.runId !== lease.runId)
      throw new Error("Review snapshot lease ownership mismatch");
    const safe = validateDraft(draft);
    const inputHash = reviewSnapshotInputHash({
      analysisId: safe.analysisId,
      runId: safe.runId,
      preparationVersion: safe.preparationVersion,
      schemaVersion: safe.schemaVersion,
      locale: safe.locale,
      projection: safe.input,
      imageManifest: safe.imageManifest,
    });
    const existing = await this.loadSnapshot(lease.analysisId, lease.runId);
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw new Error("Review run already has a different immutable input snapshot");
      return existing;
    }
    const snapshot = { ...safe, inputHash };
    const { data, error } = await this.client.rpc("pin_review_run_snapshot", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_input_hash: inputHash,
      p_snapshot: snapshot,
    });
    if (error) throw reviewRpcError("Could not pin review run snapshot", error);
    const id = data as string;
    if (!id) throw new Error("Could not pin review run snapshot: no ID returned");
    const saved = await this.loadSnapshot(lease.analysisId, lease.runId);
    if (!saved || saved.id !== id || saved.inputHash !== inputHash) {
      throw new Error("Could not reload the immutable review run snapshot");
    }
    return saved;
  }

  async loadSnapshot(analysisId: string, runId: string): Promise<ReviewRunSnapshot | null> {
    const { data, error } = await this.client
      .from("review_run_snapshots")
      .select("id, analysis_id, run_id, input_hash, snapshot, created_at")
      .eq("analysis_id", analysisId)
      .eq("run_id", runId)
      .maybeSingle();
    if (error) throw reviewRpcError("Could not load review run snapshot", error);
    if (!data) return null;
    const stored = (data.snapshot ?? {}) as Omit<ReviewRunSnapshot, "id" | "createdAt">;
    if (stored.analysisId !== analysisId || stored.runId !== runId || stored.inputHash !== data.input_hash) {
      throw new Error("Stored review snapshot ownership or hash is invalid");
    }
    return { ...stored, id: data.id as string, createdAt: data.created_at as string };
  }

  async saveProgress(
    lease: ReviewLease,
    result: import("@/server/repositories/analyses").VersionedStageResult,
  ): Promise<void> {
    const { error } = await this.client.rpc("save_review_progress", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_result: result,
    });
    if (error) throw reviewRpcError("Could not persist owned review progress", error);
  }

  async loadExecutions(analysisId: string, runId: string): Promise<ReviewExecutionRecord[]> {
    const { data, error } = await this.client
      .from("review_executions")
      .select("*")
      .eq("analysis_id", analysisId)
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) throw reviewRpcError("Could not load review executions", error);
    return ((data ?? []) as Array<Record<string, unknown>>).map(mapExecution);
  }

  async ensureExecution(
    lease: ReviewLease,
    snapshotId: string,
    descriptor: ReviewExecutionDescriptor,
  ): Promise<ReviewExecutionRecord> {
    const input = ReviewInputSchema.parse(descriptor.input);
    if (input.analysisId !== lease.analysisId || input.runId !== lease.runId)
      throw new Error("Review execution input ownership mismatch");
    const snapshot = await this.loadSnapshot(lease.analysisId, lease.runId);
    if (!snapshot || snapshot.id !== snapshotId) throw new Error("Review snapshot does not belong to the active run");
    const passPin = snapshot.passes[input.pass];
    if (passPin.availability !== "ready")
      throw new Error("Review pass is not configured as available in the pinned snapshot");
    if (
      canonicalReviewJson({
        vehicle: input.vehicle,
        listing: input.listing,
        sourceRecords: input.sourceRecords,
        evidence: input.evidence,
      }) !== canonicalReviewJson(snapshot.input)
    )
      throw new Error("Review execution input differs from the pinned snapshot");
    const imageIds = input.images.map((image) => image.evidenceId);
    const evidenceIds = [
      ...new Set([...input.evidence.map((evidence) => evidence.id), ...(input.pass === "image" ? imageIds : [])]),
    ];
    if (input.pass === "image") {
      const image = snapshot.imageManifest.images.find((entry) => entry.evidenceId === input.imageEvidenceId);
      if (!image || !image.selected || image.status !== "accepted" || !image.contentHash || !image.storageKey) {
        throw new Error("Review image is not an accepted image in the pinned snapshot");
      }
    }
    let priorExecutionIds: string[] = [];
    let priorResultHashes: Array<{ executionId: string; resultHash: string }> = [];
    if (input.pass === "final") {
      const executions = await this.loadExecutions(lease.analysisId, lease.runId);
      const expectedIds: string[] = [];
      const text = executions.find(
        (execution) => execution.pass === "text" && execution.result && execution.resultHash,
      );
      if (!text) throw new Error("Final review is waiting for the committed text review");
      expectedIds.push(text.id);
      for (const image of snapshot.imageManifest.images.filter((entry) => entry.selected)) {
        if (image.status !== "accepted") throw new Error("Final review is waiting for a selected image review");
        const execution = executions.find(
          (candidate) =>
            candidate.pass === "image" &&
            candidate.imageEvidenceId === image.evidenceId &&
            candidate.result &&
            candidate.resultHash,
        );
        if (!execution) throw new Error("Final review is waiting for every selected image review");
        expectedIds.push(execution.id);
      }
      if (input.priorReviews?.map((review) => review.executionId).join("\0") !== expectedIds.join("\0")) {
        throw new Error("Final review prior executions do not match the pinned run barrier");
      }
      priorExecutionIds = expectedIds;
      priorResultHashes = expectedIds.map((executionId) => {
        const execution = executions.find((candidate) => candidate.id === executionId)!;
        return { executionId, resultHash: execution.resultHash! };
      });
    }
    const safeProjection = sanitizeReviewAuditValue(reviewInputProjection(input)) as Record<string, unknown>;
    const fingerprint = hash(
      canonicalReviewJson({
        snapshotId,
        inputHash: snapshot.inputHash,
        pass: input.pass,
        imageEvidenceId: input.imageEvidenceId ?? null,
        imageIds,
        evidenceIds,
        promptHash: passPin.prompt.hash,
        provider: passPin.provider,
        model: passPin.model,
        reasoningEffort: passPin.reasoningEffort ?? null,
        options: passPin.options,
        priorResultHashes,
        requestProjection: safeProjection,
      }),
    );
    const { data, error } = await this.client.rpc("ensure_review_execution", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_snapshot_id: snapshotId,
      p_pass: input.pass,
      p_image_evidence_id: input.imageEvidenceId ?? null,
      p_fingerprint: fingerprint,
      p_evidence_ids: evidenceIds,
      p_request_projection: safeProjection,
      p_prior_execution_ids: priorExecutionIds,
      p_prior_result_hashes: priorResultHashes,
    });
    if (error) throw reviewRpcError("Could not ensure review execution", error);
    const executionId = data as string;
    if (!executionId) throw new Error("Could not ensure review execution: no ID returned");
    const loaded = (await this.loadExecutions(lease.analysisId, lease.runId)).find(
      (record) => record.id === executionId,
    );
    if (!loaded || loaded.fingerprint !== fingerprint) throw new Error("Could not reload the exact review execution");
    return loaded;
  }

  async startAttempt(lease: ReviewLease, executionId: string): Promise<ReviewAttemptRecord> {
    const { data, error } = await this.client.rpc("start_review_attempt", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_execution_id: executionId,
    });
    if (error) throw reviewRpcError("Could not start review attempt", error);
    const row = (data as Array<{ attempt_id: string; attempt_number: number }> | null)?.[0];
    if (!row) throw new Error("Could not start review attempt: no attempt returned");
    return { id: row.attempt_id, attemptNumber: row.attempt_number };
  }

  async commitAttempt(
    lease: ReviewLease,
    attemptId: string,
    input: {
      outcome: "success" | "failure" | "unavailable" | "lost";
      result?: unknown;
      warningCode?: string;
      providerRequestId?: string;
      publication?: ReviewPublication;
    },
  ): Promise<void> {
    const result = input.outcome === "success" ? ReviewResultSchema.parse(input.result) : null;
    if (result?.warnings.length) throw new Error("A review result with warnings cannot commit as success");
    if (input.warningCode && !SAFE_CODE_PATTERN.test(input.warningCode))
      throw new Error("Review warning code is not safe to persist");
    if (input.providerRequestId && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.providerRequestId))
      throw new Error("Provider request ID is not safe to persist");
    const safePublication = input.publication
      ? (sanitizeReviewAuditValue(input.publication) as ReviewPublication)
      : null;
    const publication = safePublication
      ? {
          assembly_result: safePublication.assemblyResult,
          status: safePublication.status,
          verdict: safePublication.verdict,
          confidence: safePublication.confidence,
          completed_at: safePublication.completedAt,
          findings: safePublication.findings,
          actions: safePublication.actions,
        }
      : null;
    if (publication && Buffer.byteLength(canonicalReviewJson(publication), "utf8") > 1_000_000)
      throw new Error("Review publication exceeds the audit size limit");
    const { error } = await this.client.rpc("commit_review_attempt", {
      p_analysis_id: lease.analysisId,
      p_run_id: lease.runId,
      p_job_id: lease.jobId,
      p_worker_id: lease.workerId,
      p_attempt_id: attemptId,
      p_outcome: input.outcome,
      p_result: result,
      p_warning_code: input.warningCode ?? null,
      p_provider_request_id: input.providerRequestId ?? null,
      p_publication: publication,
    });
    if (error) throw reviewRpcError("Could not commit review attempt", error);
  }
}
