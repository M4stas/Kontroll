import { createHash } from "node:crypto";
import type { NormalizedVehicle } from "@/analysis/normalize";
import { expect, it, vi } from "vitest";
import { resolveReviewConfig } from "@/config/review";
import {
  canonicalReviewJson,
  createReviewPassPins,
  sanitizeReviewAuditValue,
  reviewSnapshotInputHash,
  ReviewExecutionsRepository,
} from "@/server/repositories/review-executions";

function normalizedVehicle(make?: string): NormalizedVehicle {
  return {
    ...(make ? { make } : {}),
    provenance: {
      make: [],
      model: [],
      year: [],
      mileageKm: [],
      fuel: [],
      transmission: [],
      vin: [],
      registrationPlate: [],
      generation: [],
      engineVariant: [],
      gearboxVariant: [],
    },
    conflicts: [],
  };
}

const capabilities = {
  responses: true,
  text: true,
  structuredOutput: true,
  imageInput: true,
  efforts: ["low", "medium"] as const,
};

it("pins effective per-pass settings and prompts without persisting credentials", () => {
  const secret = "sk-proj-very-secret-api-key-value";
  const config = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_MODEL: "text-model",
      DATA_REVIEW_IMAGE_MODEL: "image-model",
      OPENAI_API_KEY: secret,
    },
    { openai: { "text-model": capabilities, "image-model": capabilities } },
  );

  const pins = createReviewPassPins(config, "en");
  const encoded = canonicalReviewJson(pins);
  expect(pins.mode).toBe("split");
  expect(pins.passes.text.model).toBe("text-model");
  expect(pins.passes.image.model).toBe("image-model");
  expect(pins.passes.final.model).toBe("text-model");
  expect(pins.passes.text.prompt.content).toContain("English");
  expect(pins.passes.text.prompt.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(encoded).not.toContain(secret);
  expect(encoded).not.toContain("apiKey");
});

it("pins a 120-second deadline for Codex passes while keeping OpenAI passes at 75 seconds", () => {
  const config = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_PROVIDER: "codex",
      DATA_REVIEW_TEXT_MODEL: "codex-text-model",
      DATA_REVIEW_IMAGE_PROVIDER: "openai",
      DATA_REVIEW_IMAGE_MODEL: "openai-image-model",
      OPENAI_API_KEY: "openai-test-key",
    },
    {
      codex: { "codex-text-model": capabilities },
      openai: { "openai-image-model": capabilities },
    },
  );

  const { passes } = createReviewPassPins(config, "en");

  expect(passes.text.options.timeoutMs).toBe(120_000);
  expect(passes.final.options.timeoutMs).toBe(120_000);
  expect(passes.image.options.timeoutMs).toBe(75_000);
});

it("pins a 300-second deadline for max-effort Codex passes", () => {
  const config = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_PROVIDER: "codex",
      DATA_REVIEW_TEXT_MODEL: "codex-text-model",
      DATA_REVIEW_TEXT_REASONING_EFFORT: "max",
      DATA_REVIEW_IMAGE_PROVIDER: "openai",
      DATA_REVIEW_IMAGE_MODEL: "openai-image-model",
      OPENAI_API_KEY: "openai-test-key",
    },
    {
      codex: { "codex-text-model": { ...capabilities, efforts: ["max"] } },
      openai: { "openai-image-model": capabilities },
    },
  );

  const { passes } = createReviewPassPins(config, "en");

  expect(passes.text.reasoningEffort).toBe("max");
  expect(passes.text.options.timeoutMs).toBe(300_000);
  expect(passes.final.options.timeoutMs).toBe(300_000);
  expect(passes.image.options.timeoutMs).toBe(75_000);
});

it("redacts credential strings and strips URL query and fragment data from audit values", () => {
  const safe = sanitizeReviewAuditValue({
    sourceUrl: "https://example.test/listing?access_token=url-secret#fragment-secret",
    diagnostic: "api_key=raw-secret Bearer bearer-secret",
    apiKey: "api-key-field-secret",
    capability: "capability-secret",
    signedUrl: "https://bucket.test/object?token=signed-url-secret",
    token: "token-field-secret",
    nested: { signature: "signed-url-secret", value: "sk-proj-another-secret-key-value" },
  });

  expect(safe).toEqual({
    sourceUrl: "https://example.test/listing",
    diagnostic: "api_key=[redacted] Bearer [redacted]",
    nested: { value: "[redacted-key]" },
  });
  expect(canonicalReviewJson(safe)).not.toMatch(
    /raw-secret|url-secret|fragment-secret|bearer-secret|api-key-field-secret|capability-secret|signed-url-secret|token-field-secret|another-secret/,
  );
});

it("keeps the max-effort Codex deadline and maxOutputTokens in a sanitized pinned snapshot", async () => {
  const config = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_PROVIDER: "codex",
      DATA_REVIEW_TEXT_MODEL: "text-model",
      DATA_REVIEW_TEXT_REASONING_EFFORT: "max",
      DATA_REVIEW_IMAGE_MODEL: "image-model",
      OPENAI_API_KEY: "sk-proj-pinned-test-secret-key",
    },
    {
      codex: { "text-model": { ...capabilities, efforts: ["max"] } },
      openai: { "image-model": capabilities },
    },
  );
  const pins = createReviewPassPins(config, "en");
  const safePins = sanitizeReviewAuditValue(pins) as typeof pins;
  expect(safePins.passes.text.options.maxOutputTokens).toBeNull();
  expect(safePins.passes.text.options.timeoutMs).toBe(300_000);

  const rpc = vi.fn().mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockImplementation(async () => ({
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          analysis_id: id,
          run_id: "22222222-2222-4222-8222-222222222222",
          input_hash: rpc.mock.calls[0]?.[1]?.p_input_hash,
          snapshot: rpc.mock.calls[0]?.[1]?.p_snapshot,
          created_at: "2026-10-01T11:00:00.000Z",
        },
        error: null,
      })),
  };
  const repository = new ReviewExecutionsRepository({ rpc, from: vi.fn(() => query) } as never);
  const id = "11111111-1111-4111-8111-111111111111";
  const lease = {
    analysisId: id,
    runId: "22222222-2222-4222-8222-222222222222",
    jobId: "44444444-4444-4444-8444-444444444444",
    workerId: "review-unit-worker",
  };
  const draft = {
    analysisId: id,
    runId: "22222222-2222-4222-8222-222222222222",
    preparationVersion: 1,
    schemaVersion: 1,
    locale: "en" as const,
    mode: "split" as const,
    input: { vehicle: normalizedVehicle(), listing: null, sourceRecords: [], evidence: [] },
    imageManifest: {
      counts: { supplied: 0, selected: 0, accepted: 0, skipped: 0, rejected: 0, unavailable: 0 },
      images: [],
    },
    passes: pins.passes,
  };
  await expect(repository.pinRunSnapshot(lease, draft)).resolves.toMatchObject({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const outOfRangePins = {
    ...pins.passes,
    text: { ...pins.passes.text, options: { ...pins.passes.text.options, timeoutMs: 300_001 } },
  };
  await expect(repository.pinRunSnapshot(lease, { ...draft, passes: outOfRangePins })).rejects.toThrow();
  expect(rpc).toHaveBeenCalledTimes(1);
  const pinnedSnapshot = rpc.mock.calls[0]?.[1]?.p_snapshot;
  expect(pinnedSnapshot).toBeDefined();
  if (typeof pinnedSnapshot !== "object" || pinnedSnapshot === null)
    throw new Error("RPC did not receive a pinned snapshot");
  const stored = pinnedSnapshot as { passes: { text: { options: { maxOutputTokens: null } } } };
  expect(canonicalReviewJson(pinnedSnapshot)).not.toContain("sk-proj-pinned-test-secret-key");
  expect(stored.passes.text.options.maxOutputTokens).toBeNull();
});

it("sends final publication in the snake_case RPC wire format", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const repository = new ReviewExecutionsRepository({ rpc } as never);
  const publication = {
    assemblyResult: { version: 1, status: "complete", output: { evidenceIds: [] } },
    status: "complete" as const,
    verdict: "proceed_cautiously",
    confidence: "low",
    completedAt: "2026-10-01T12:00:00.000Z",
    findings: [],
    actions: [],
  };
  await repository.commitAttempt(
    {
      analysisId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      jobId: "44444444-4444-4444-8444-444444444444",
      workerId: "review-unit-worker",
    },
    "55555555-5555-4555-8555-555555555555",
    {
      outcome: "success",
      result: { schemaVersion: 1, observations: [], warnings: [] },
      publication,
    },
  );
  expect(rpc.mock.calls[0]?.[1]?.p_publication).toEqual({
    assembly_result: publication.assemblyResult,
    status: "complete",
    verdict: "proceed_cautiously",
    confidence: "low",
    completed_at: publication.completedAt,
    findings: [],
    actions: [],
  });
});

it("pins prompt hashes while returning the first source snapshot on a same-input retry", async () => {
  const oldConfig = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_MODEL: "old-text",
      DATA_REVIEW_IMAGE_MODEL: "old-image",
      OPENAI_API_KEY: "sk-proj-old-test-secret",
    },
    {
      openai: {
        "old-text": capabilities,
        "old-image": capabilities,
        "new-text": capabilities,
        "new-image": capabilities,
      },
    },
  );
  const newConfig = resolveReviewConfig(
    {
      DATA_REVIEW_MODE: "split",
      DATA_REVIEW_TEXT_MODEL: "new-text",
      DATA_REVIEW_IMAGE_MODEL: "new-image",
      OPENAI_API_KEY: "sk-proj-new-test-secret",
    },
    {
      openai: {
        "old-text": capabilities,
        "old-image": capabilities,
        "new-text": capabilities,
        "new-image": capabilities,
      },
    },
  );
  const oldPins = createReviewPassPins(oldConfig, "en").passes;
  const changedPins = createReviewPassPins(newConfig, "en").passes;
  const changedPrompt = "Edited after this run was pinned.";
  changedPins.final.prompt = { content: changedPrompt, hash: createHash("sha256").update(changedPrompt).digest("hex") };
  const analysisId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const draft = {
    analysisId,
    runId,
    preparationVersion: 1,
    schemaVersion: 1,
    locale: "en" as const,
    mode: "split" as const,
    input: { vehicle: normalizedVehicle(), listing: null, sourceRecords: [], evidence: [] },
    imageManifest: {
      counts: { supplied: 0, selected: 0, accepted: 0, skipped: 0, rejected: 0, unavailable: 0 },
      images: [],
    },
  };
  const hashInput = { ...draft, projection: draft.input };
  const savedInputHash = reviewSnapshotInputHash({ ...hashInput });
  const savedSnapshot = { ...draft, passes: oldPins, inputHash: savedInputHash };
  expect(oldPins.text.model).not.toBe(changedPins.text.model);
  expect(oldPins.final.prompt.hash).not.toBe(changedPins.final.prompt.hash);
  const changedPinIdentity = { ...hashInput, passes: changedPins };
  expect(reviewSnapshotInputHash(changedPinIdentity)).toBe(savedInputHash);
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          analysis_id: analysisId,
          run_id: runId,
          input_hash: savedSnapshot.inputHash,
          snapshot: savedSnapshot,
          created_at: "2026-10-01T11:00:00.000Z",
        },
        error: null,
      }),
  };
  const client = {
    rpc: vi.fn().mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null }),
    from: vi.fn(() => query),
  };
  const repository = new ReviewExecutionsRepository(client as never);
  const returned = await repository.pinRunSnapshot(
    { analysisId, runId, jobId: "44444444-4444-4444-8444-444444444444", workerId: "review-unit-worker" },
    { ...draft, passes: changedPins },
  );
  expect(returned.passes.text.model).toBe("old-text");
  expect(returned.passes.final.prompt.content).not.toBe(changedPrompt);
  expect(returned.createdAt).toBe("2026-10-01T11:00:00.000Z");
  expect(client.rpc).not.toHaveBeenCalled();
  await expect(
    repository.pinRunSnapshot(
      { analysisId, runId, jobId: "44444444-4444-4444-8444-444444444444", workerId: "review-unit-worker" },
      { ...draft, input: { ...draft.input, vehicle: normalizedVehicle("Changed source input") }, passes: changedPins },
    ),
  ).rejects.toThrow("different immutable input snapshot");
});
