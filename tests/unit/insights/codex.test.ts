import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightEnvironment } from "@/insights/types";
import type { ReviewPassPin } from "@/server/repositories/review-executions";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { reviewerEvaluationCases } from "../../fixtures/reviewer-evaluations";
import { createCodexDataReviewer, type CodexCommandRequest, type CodexReviewerDependencies } from "@/insights/codex";

const normalInput = reviewerEvaluationCases.find((item) => item.id === "normal-listing-en")!.input;
const imageInput = reviewerEvaluationCases.find((item) => item.id === "wheel-image-observation")!.input;
const validResult = { schemaVersion: 1 as const, observations: [], warnings: [] };
const turnCompleted = `${JSON.stringify({ type: "turn.completed" })}\n`;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function pin(overrides: Partial<ReviewPassPin> = {}): ReviewPassPin {
  return {
    availability: "ready",
    provider: "codex",
    model: "gpt-6.1-sol",
    reasoningEffort: "medium",
    capabilities: { responses: false, text: true, structuredOutput: true, imageInput: true, efforts: ["medium"] },
    options: {
      timeoutMs: 2_000,
      imageDetail: "high",
      outputFormat: "json_schema",
      outputStrict: true,
      outputSchemaVersion: 1,
      maxOutputTokens: null,
      temperature: null,
    },
    prompt: { content: "Pinned reviewer instructions", hash: "a".repeat(64) },
    ...overrides,
  };
}

function env(overrides: Record<string, string | undefined> = {}): InsightEnvironment {
  return {
    HOME: "/home/codex-user",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp/codex-test",
    CODEX_HOME: "/home/codex-user/.codex",
    OPENAI_API_KEY: "must-not-leak",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
    DATABASE_URL: "must-not-leak",
    DATA_REVIEW_CODEX_COMMAND: "codex-test-bin",
    ...overrides,
  };
}

function eventFor(itemType = "agent_message"): string {
  return `${JSON.stringify({ type: "item.completed", item: { type: itemType } })}\n${turnCompleted}`;
}

function successfulCommand(
  output: unknown,
  stdout = eventFor(),
  onRequest?: (request: CodexCommandRequest) => void | Promise<void>,
): NonNullable<CodexReviewerDependencies["runCommand"]> {
  return async (request) => {
    await onRequest?.(request);
    await writeFile(request.resultPath, JSON.stringify(output), { mode: 0o600 });
    return { exitCode: 0, stdout, stderr: "private diagnostic" };
  };
}

describe("Codex data reviewer adapter", () => {
  it("uses only allowlisted environment and pinned instructions, model, schema, and read-only arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-test-"));
    tempRoots.push(root);
    let requestSeen: CodexCommandRequest | undefined;
    let pinnedInstructions = "";
    let schemaDocument: unknown;
    const reviewer = createCodexDataReviewer(pin(), env(), {}, {
      tempDirectory: root,
      runCommand: successfulCommand(validResult, eventFor(), async (request) => {
        requestSeen = request;
        pinnedInstructions = await readFile(request.instructionsPath, "utf8");
        schemaDocument = JSON.parse(await readFile(request.schemaPath, "utf8"));
      }),
    });

    const reviewInput = {
      ...normalInput,
      sourceRecords: [{
        ...normalInput.sourceRecords[0]!,
        content: "Reference https://storage.example/object?X-Amz-Signature=credential-to-hide",
      }],
    };
    const result = await reviewer.review(reviewInput);

    expect(result).toEqual(validResult);
    expect(requestSeen).toBeDefined();
    const request = requestSeen!;
    expect(request.command).toBe("codex-test-bin");
    expect(request.env).toEqual({
      NODE_ENV: "production",
      HOME: "/home/codex-user",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/codex-test",
      CODEX_HOME: "/home/codex-user/.codex",
    });
    expect(request.args).toContain("--ignore-user-config");
    expect(request.args).toContain("--ephemeral");
    expect(request.args).toContain("--sandbox");
    expect(request.args).toContain("read-only");
    expect(request.args).toContain("--model");
    expect(request.args).toContain("gpt-6.1-sol");
    expect(request.args).toContain("--output-schema");
    expect(request.args).toContain("--output-last-message");
    expect(request.args).toContain("--json");
    expect(request.args).toContain("-");
    expect(request.args.some((arg) => arg.includes('model_reasoning_effort="medium"'))).toBe(true);
    expect(request.stdin).not.toContain("must-not-leak");
    expect(request.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(request.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(request.stdin).not.toContain("analysisId");
    expect(request.stdin).not.toContain("runId");
    expect(request.stdin).not.toContain("sourceUrl");
    expect(request.stdin).not.toContain("photo_urls");
    expect(request.stdin).not.toContain("credential-to-hide");
    expect(request.stdin).toContain("<UNTRUSTED_REVIEW_INPUT>");
    expect(pinnedInstructions).toBe("Pinned reviewer instructions");
    expect(schemaDocument).toMatchObject({ type: "object" });
    expect(await readdir(root)).toEqual([]);
  });

  it("maps the pinned timeout to a timeout warning and aborts the running command", async () => {
    const runner = vi.fn(async (request: CodexCommandRequest) => new Promise<never>((_resolve, reject) => {
      if (request.signal.aborted) reject(new Error("aborted"));
      else request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const reviewer = createCodexDataReviewer(pin({ options: { ...pin().options, timeoutMs: 15 } }), env(), {}, {
      runCommand: runner,
    });

    const result = await reviewer.review(normalInput);

    expect(runner).toHaveBeenCalledOnce();
    expect(result.warnings[0]?.code).toBe("timeout");
    expect(result.observations).toEqual([]);
  });

  it("accepts the known Code Mode disabled startup advisory with a valid completed result", async () => {
    const message = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
    const stdout = `${JSON.stringify({ type: "item.completed", item: { type: "error", message } })}\n${eventFor()}`;
    const reviewer = createCodexDataReviewer(pin(), env(), {}, {
      runCommand: successfulCommand(validResult, stdout),
    });

    expect(await reviewer.review(normalInput)).toEqual(validResult);
  });

  it("rejects unrecognized error items", async () => {
    const stdout = `${JSON.stringify({ type: "item.completed", item: { type: "error", message: "A different error happened." } })}\n${eventFor()}`;
    const reviewer = createCodexDataReviewer(pin(), env(), {}, {
      runCommand: successfulCommand(validResult, stdout),
    });

    expect((await reviewer.review(normalInput)).warnings[0]?.code).toBe("invalid_output");
  });

  it("rejects tool activity even when the output file contains valid JSON", async () => {
    const runner = vi.fn(successfulCommand(validResult, eventFor("mcp_tool_call")));
    const reviewer = createCodexDataReviewer(pin(), env(), {}, { runCommand: runner });

    const result = await reviewer.review(normalInput);

    expect(result.warnings[0]?.code).toBe("invalid_output");
    expect(result.observations).toEqual([]);
  });

  it("rejects fabricated evidence references and malformed output", async () => {
    const fabricated = {
      schemaVersion: 1,
      observations: [{
        id: "observation-1",
        evidenceIds: ["not-supplied"],
        category: "identity",
        title: "Unsupported claim",
        severity: "important",
        explanation: "This reference was not present in the input.",
        recommendedAction: { kind: "inspection_task", title: "Check", instructions: "Inspect." },
        confidence: 0.5,
      }],
      warnings: [],
    };
    const reviewer = createCodexDataReviewer(pin(), env(), {}, {
      runCommand: successfulCommand(fabricated),
    });
    expect((await reviewer.review(normalInput)).warnings[0]?.code).toBe("invalid_output");

    const malformed = createCodexDataReviewer(pin(), env(), {}, {
      runCommand: async (request) => {
        await writeFile(request.resultPath, "not-json", { mode: 0o600 });
        return { exitCode: 0, stdout: turnCompleted, stderr: "private diagnostic" };
      },
    });
    expect((await malformed.review(normalInput)).warnings[0]?.code).toBe("invalid_output");
  });

  it.each([{ width: 2, height: 2, padded: false }, { width: 6000, height: 4000, padded: false }, { width: 2, height: 2, padded: true }])("reviews accepted private images within upload limits: %j", async ({ width, height, padded }) => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-test-"));
    tempRoots.push(root);
    const encoded = await sharp({ create: { width, height, channels: 3, background: { r: 4, g: 8, b: 12 } } }).png().toBuffer();
    const png = padded ? Buffer.concat([encoded, Buffer.alloc(11 * 1024 * 1024 - encoded.length)]) : encoded;
    const signedUrl = "https://storage.example/storage/v1/object/sign/private?token=do-not-forward";
    let requestSeen: CodexCommandRequest | undefined;
    let localImage = Buffer.alloc(0);
    let fetchRedirect: RequestRedirect | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(signedUrl);
      fetchRedirect = init?.redirect;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };
    const imageBoundary = {
      imageUrlVerifier: {
        verifyServerIssuedCapability: () => ({
          analysisId: imageInput.analysisId,
          evidenceId: imageInput.imageEvidenceId!,
          storageKey: `${imageInput.analysisId}/review-photo.webp`,
          signedUrl,
          expiresAt: "2100-01-01T00:00:00.000Z",
        }),
      },
      allowedStorageOrigins: ["https://storage.example"],
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    };
    const reviewer = createCodexDataReviewer(pin(), env(), imageBoundary, {
      tempDirectory: root,
      fetchImpl,
      runCommand: successfulCommand(validResult, eventFor(), async (request) => {
        requestSeen = request;
        localImage = await readFile(request.imagePath!);
      }),
    });

    const result = await reviewer.review(imageInput);

    expect(result).toEqual(validResult);
    expect(fetchRedirect).toBe("error");
    expect(requestSeen).toBeDefined();
    expect(localImage.length).toBeGreaterThan(0);
    const metadata = await sharp(localImage).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1600);
    expect(metadata.height).toBeLessThanOrEqual(1600);
    expect(requestSeen?.args).toContain("--image");
    expect(requestSeen?.imagePath).toMatch(/review-image\.png$/);
    expect((await fileTypeFromBuffer(new Uint8Array(localImage)))?.mime).toBe("image/png");
    expect(requestSeen?.stdin).not.toContain("do-not-forward");
    expect(requestSeen?.args).not.toContain(signedUrl);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['pixels', 'declared_bytes', 'streamed_bytes'] as const)("rejects oversized private images before invoking Codex: %s", async (bound) => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-bound-test-"));
    tempRoots.push(root);
    const png = bound === 'pixels'
      ? await sharp({create: {width: 6400, height: 6400, channels: 3, background: '#123456'}}).png().toBuffer()
      : Buffer.alloc(12 * 1024 * 1024 + 1);
    const runCommand = vi.fn(successfulCommand(validResult));
    const reviewer = createCodexDataReviewer(pin(), env(), {
      imageUrlVerifier: {verifyServerIssuedCapability: () => ({
        analysisId: imageInput.analysisId, evidenceId: imageInput.imageEvidenceId!,
        storageKey: `${imageInput.analysisId}/large.png`, signedUrl: 'https://storage.example/private',
        expiresAt: '2100-01-01T00:00:00.000Z',
      })},
      allowedStorageOrigins: ['https://storage.example'],
    }, {
      tempDirectory: root,
      fetchImpl: async () => new Response(png, {status: 200,
        headers: bound === 'declared_bytes' ? {'content-length': String(png.length)} : {}}),
      runCommand,
    });
    expect((await reviewer.review(imageInput)).warnings[0]?.code).toBe('unavailable');
    expect(runCommand).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a forged image capability before fetching or starting Codex", async () => {
    const runCommand = vi.fn(successfulCommand(validResult));
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const reviewer = createCodexDataReviewer(pin(), env(), {
      imageUrlVerifier: { verifyServerIssuedCapability: () => null },
      allowedStorageOrigins: ["https://storage.example"],
    }, { runCommand, fetchImpl });

    const result = await reviewer.review(imageInput);

    expect(result.warnings[0]?.code).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

it('separates reviewer retrieval, verification and PNG work from command time', async () => {
  const {PhotoTimingRecorder,runPhotoTimingJob,withPhotoTiming}=await import('@/diagnostics/photo-timings');
  const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const spans: Array<{phase:string;state:string;durationMs:number|null}>=[];
  let tick=0;
  const recorder=new PhotoTimingRecorder({enabled:true,monotonic:()=>tick,write:async rows=>{spans.push(...rows);}});
  const reviewer=createCodexDataReviewer(pin(),env(),{imageUrlVerifier:{verifyServerIssuedCapability:()=>({analysisId:imageInput.analysisId,evidenceId:imageInput.imageEvidenceId!,storageKey:`${imageInput.analysisId}/image.png`,signedUrl:'https://storage.example/photo',expiresAt:'2100-01-01T00:00:00Z'})},allowedStorageOrigins:['https://storage.example']},{fetchImpl:async()=>{tick=10;return new Response(png,{status:200});},runCommand:successfulCommand(validResult,eventFor(),()=>{tick=10000;})});
  expect(await runPhotoTimingJob(recorder,()=>withPhotoTiming(imageInput.imageEvidenceId!,()=>reviewer.review(imageInput)))).toEqual(validResult);
  expect(spans.filter(s=>s.state==='complete').map(s=>s.phase)).toEqual(['retrieval','verification','png_preparation','reviewer_prepare']);
  expect(spans.find(s=>s.phase==='reviewer_prepare'&&s.state==='complete')?.durationMs).toBe(10);
});
