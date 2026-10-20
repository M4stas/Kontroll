import { measurePhotoPhase } from "@/diagnostics/photo-timings";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, REVIEW_IMAGE_DIMENSION } from "@/config/image-policy";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { toJSONSchema } from "zod";
import { ReviewInputSchema, ReviewResultSchema } from "@/insights/provider";
import { acceptedInsightImages } from "@/insights/prompt";
import type { InsightEnvironment, InsightImageBoundaryOptions, ReviewInput, ReviewResult, DataReviewer } from "@/insights/types";
import type { ReviewPassPin } from "@/server/repositories/review-executions";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_ITEM_TYPES = new Set(["agent_message", "reasoning"]);
const CODE_MODE_DISABLED_ADVISORY = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const FORBIDDEN_EVENT_PATTERN = /(?:tool|web.?search|command.?execution|shell|mcp|browser|function.?call|file.?change|unified.?exec|shell.?snapshot|multi.?agent|image.?view)/i;
const SENSITIVE_KEY_PATTERN = /(?:capability|signed.?url|storage.?key|secret|credential|api.?key|access.?token)/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b/gi;

export interface CodexCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
  instructionsPath: string;
  schemaPath: string;
  resultPath: string;
  imagePath?: string;
}

export interface CodexCommandResult {
  exitCode: number | null;
  stdout: string;
  /** Kept only for transport tests; production diagnostics are discarded. */
  stderr?: string;
}

export interface CodexReviewerDependencies {
  runCommand?: (request: CodexCommandRequest) => Promise<CodexCommandResult>;
  fetchImpl?: typeof fetch;
  tempDirectory?: string;
  now?: () => Date;
}

class InvalidCodexOutputError extends Error {}
class CodexTimeoutError extends Error {}
class PrivateImageError extends Error {}

function resultWarning(code: ReviewResult["warnings"][number]["code"], message: string): ReviewResult {
  return { schemaVersion: 1, observations: [], warnings: [{ code, message }] };
}

function safeEnvironment(source: InsightEnvironment): Record<string, string> {
  const environment: Record<string, string> = { NODE_ENV: "production" };
  for (const key of ["HOME", "PATH", "TMPDIR", "CODEX_HOME"] as const) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function privateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const sensitiveParameters = /(?:^|[-_])(?:token|signature|credential|api[-_]?key|access[-_]?key|auth)(?:$|[-_])/i;
    return url.pathname.toLowerCase().includes("/object/sign/")
      || [...url.searchParams.keys()].some((key) => sensitiveParameters.test(key));
  } catch {
    return false;
  }
}

function safeString(value: string): string {
  return value
    .replace(URL_PATTERN, (url) => privateUrl(url) ? "[private URL omitted]" : url)
    .replace(CREDENTIAL_PATTERN, "[credential omitted]");
}

function safeProjectionValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return undefined;
  if (typeof value === "string") return safeString(value);
  if (Array.isArray(value)) return value.map((item) => safeProjectionValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
      const safeValue = safeProjectionValue(entryValue, entryKey);
      return safeValue === undefined ? [] : [[entryKey, safeValue]];
    }));
  }
  return value;
}

function untrustedProjection(input: ReviewInput): string {
  const listing = input.listing
    ? Object.fromEntries(Object.entries(input.listing).filter(([key]) => key !== "photo_urls"))
    : null;
  const evidence = input.evidence.map((item) => Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "sourceUrl"),
  ));
  const projection = {
    locale: input.locale,
    pass: input.pass,
    ...(input.imageEvidenceId ? { imageEvidenceId: input.imageEvidenceId } : {}),
    vehicle: input.vehicle,
    listing,
    sourceRecords: input.sourceRecords,
    evidence,
    ...(input.priorReviews ? { priorReviews: input.priorReviews } : {}),
  };
  return `<UNTRUSTED_REVIEW_INPUT>\n${JSON.stringify(safeProjectionValue(projection))}\n</UNTRUSTED_REVIEW_INPUT>`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexArguments(
  pin: ReviewPassPin,
  directory: string,
  instructionsPath: string,
  schemaPath: string,
  resultPath: string,
  imagePath?: string,
): string[] {
  if (!pin.model) throw new InvalidCodexOutputError("missing_model");
  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--disable", "shell_tool",
    "--disable", "unified_exec",
    "--disable", "multi_agent",
    "--disable", "shell_snapshot",
    "--disable", "skill_search",
    ...["view_image", "plugins", "remote_plugin", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "code_mode_host", "workspace_dependencies", "hooks", "sleep_tool", "goals", "skill_mcp_dependency_install", "tool_suggest", "auth_elicitation"].flatMap(feature => ["--disable", feature]),
    "-c", "web_search=\"disabled\"",
    "-c", "project_doc_max_bytes=0",
    "-c", "skills.include_instructions=false",
    "-c", "skills.max_context_tokens=1",
    "-c", "apps._default.enabled=false",
    "-c", `model_instructions_file=${tomlString(instructionsPath)}`,
  ];
  if (pin.reasoningEffort) args.push("-c", `model_reasoning_effort=${tomlString(pin.reasoningEffort)}`);
  args.push(
    "--model", pin.model,
    "--cd", directory,
    "--output-schema", schemaPath,
    "--output-last-message", resultPath,
  );
  if (imagePath) args.push("--image", imagePath);
  args.push("--json", "-");
  return args;
}

function runCodexProcess(request: CodexCommandRequest): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new CodexTimeoutError());
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("codex_spawn_failed"));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceededLimit = false;
    let settled = false;
    const complete = (callback: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => { child.kill("SIGKILL"); };
    request.signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        exceededLimit = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) {
        exceededLimit = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => complete(() => reject(new Error("codex_spawn_failed"))));
    child.once("close", (exitCode) => complete(() => {
      if (request.signal.aborted) {
        reject(new CodexTimeoutError());
      } else if (exceededLimit) {
        reject(new InvalidCodexOutputError("codex_output_exceeded_limit"));
      } else {
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8") });
      }
    }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin);
  });
}

function validateEventStream(stdout: string): void {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new InvalidCodexOutputError("empty_event_stream");
  let completed = false;
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_event");
      event = parsed as Record<string, unknown>;
    } catch {
      throw new InvalidCodexOutputError("invalid_event_stream");
    }
    const type = typeof event.type === "string" ? event.type : "";
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (FORBIDDEN_EVENT_PATTERN.test(type) || FORBIDDEN_EVENT_PATTERN.test(itemType)) {
      throw new InvalidCodexOutputError("disallowed_tool_activity");
    }
    const isCodeModeDisabledAdvisory = type === "item.completed"
      && itemType === "error"
      && item?.message === CODE_MODE_DISABLED_ADVISORY;
    if ((type === "item.started" || type === "item.completed")
      && (!itemType || (!ALLOWED_ITEM_TYPES.has(itemType) && !isCodeModeDisabledAdvisory))) {
      throw new InvalidCodexOutputError("disallowed_item_activity");
    }
    if (type === "turn.failed" || type === "error") throw new Error("codex_turn_failed");
    if (type === "turn.completed") completed = true;
  }
  if (!completed) throw new Error("codex_turn_incomplete");
}

async function readPrivateImage(
  imageUrl: string,
  directory: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const inputBytes = await measurePhotoPhase("retrieval", async () => {
    let response: Response;
    try {
      response = await fetchImpl(imageUrl, { method: "GET", redirect: "error", signal });
    } catch {
      if (signal.aborted) throw new CodexTimeoutError();
      throw new PrivateImageError("image_fetch_failed");
    }
    if (!response.ok || !response.body) throw new PrivateImageError("image_unavailable");
    const declaredLength = response.headers.get("content-length");
    if (declaredLength) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IMAGE_BYTES) {
        throw new PrivateImageError("image_too_large");
      }
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new CodexTimeoutError();
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new PrivateImageError("image_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  });
  await measurePhotoPhase("verification", async () => {
    const detected = await fileTypeFromBuffer(new Uint8Array(inputBytes));
    if (!detected || !ALLOWED_IMAGE_TYPES.has(detected.mime)) throw new PrivateImageError("unsupported_image_type");
  });
  return measurePhotoPhase("png_preparation", async () => {

    let safePng: Buffer;
    try {
      safePng = await sharp(inputBytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS })
        .rotate()
        .resize({ width: REVIEW_IMAGE_DIMENSION, height: REVIEW_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      throw new PrivateImageError("image_decode_failed");
    }
    if (safePng.length > MAX_IMAGE_BYTES) throw new PrivateImageError("image_too_large");
    const imagePath = join(directory, "review-image.png");
    await writeFile(imagePath, safePng, { mode: 0o600, flag: "wx" });
    return imagePath;
  });
}

function validateReviewResult(value: unknown, input: ReviewInput): ReviewResult {
  const parsed = ReviewResultSchema.safeParse(value);
  if (!parsed.success) throw new InvalidCodexOutputError("invalid_review_result");
  const allowedEvidenceIds = new Set(input.evidence.map((evidence) => evidence.id));
  for (const observation of parsed.data.observations) {
    if (observation.evidenceIds.some((evidenceId) => !allowedEvidenceIds.has(evidenceId))) {
      throw new InvalidCodexOutputError("fabricated_evidence_reference");
    }
    if (input.pass === "image" && !observation.evidenceIds.includes(input.imageEvidenceId!)) {
      throw new InvalidCodexOutputError("image_observation_missing_image_reference");
    }
  }
  return parsed.data;
}

export function createCodexDataReviewer(
  pin: ReviewPassPin,
  env: InsightEnvironment,
  imageOptions: InsightImageBoundaryOptions = {},
  dependencies: CodexReviewerDependencies = {},
): DataReviewer {
  const command = env.DATA_REVIEW_CODEX_COMMAND?.trim() || "codex";
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const runCommand = dependencies.runCommand ?? runCodexProcess;

  return {
    async review(rawInput): Promise<ReviewResult> {
      const parsedInput = ReviewInputSchema.safeParse(rawInput);
      if (!parsedInput.success) return resultWarning("invalid_output", "Review input did not satisfy the configured contract.");
      const input = parsedInput.data;
      if (pin.availability !== "ready" || pin.provider !== "codex" || !pin.model || !pin.prompt.content) {
        return resultWarning("unavailable", "The local Codex reviewer is not configured.");
      }
      if (input.pass === "image" && !pin.capabilities?.imageInput) {
        return resultWarning("unavailable", "The configured local reviewer cannot accept image input.");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), pin.options.timeoutMs);
      let directory: string | undefined;
      try {
        let acceptedImageUrl: string | undefined;
        if (input.pass === "image") {
          const accepted = acceptedInsightImages({
            analysisId: input.analysisId,
            images: input.images,
          }, imageOptions);
          if (accepted.length !== 1 || accepted[0]?.evidenceId !== input.imageEvidenceId) {
            return resultWarning("unavailable", "The selected private image is unavailable or not authorized.");
          }
          acceptedImageUrl = accepted[0]!.signedUrl;
        }

        directory = await mkdtemp(join(dependencies.tempDirectory ?? tmpdir(), "kontroll-codex-review-"));
        await chmod(directory, 0o700);
        const instructionsPath = join(directory, "instructions.md");
        const schemaPath = join(directory, "result-schema.json");
        const resultPath = join(directory, "result.json");
        await writeFile(instructionsPath, pin.prompt.content, { mode: 0o600, flag: "wx" });
        await writeFile(schemaPath, `${JSON.stringify(toJSONSchema(ReviewResultSchema, { target: "draft-07" }), null, 2)}\n`, { mode: 0o600, flag: "wx" });

        const imagePath = acceptedImageUrl
          ? await measurePhotoPhase("reviewer_prepare", () => readPrivateImage(acceptedImageUrl!, directory!, controller.signal, fetchImpl))
          : undefined;
        const stdin = untrustedProjection(input);
        if (Buffer.byteLength(stdin, "utf8") > MAX_INPUT_BYTES) throw new InvalidCodexOutputError("review_input_exceeded_limit");
        const request: CodexCommandRequest = {
          command,
          args: codexArguments(pin, directory, instructionsPath, schemaPath, resultPath, imagePath),
          cwd: directory,
          env: safeEnvironment(env),
          stdin,
          signal: controller.signal,
          timeoutMs: pin.options.timeoutMs,
          instructionsPath,
          schemaPath,
          resultPath,
          ...(imagePath ? { imagePath } : {}),
        };
        const processResult = await runCommand(request);
        if (controller.signal.aborted) throw new CodexTimeoutError();
        if (processResult.exitCode !== 0) throw new Error("codex_exit_failed");
        validateEventStream(processResult.stdout);

        const resultBytes = await readFile(resultPath);
        if (resultBytes.byteLength > MAX_RESULT_BYTES) throw new InvalidCodexOutputError("review_result_exceeded_limit");
        let result: unknown;
        try {
          result = JSON.parse(resultBytes.toString("utf8"));
        } catch {
          throw new InvalidCodexOutputError("review_result_not_json");
        }
        return validateReviewResult(result, input);
      } catch (error) {
        if (controller.signal.aborted || error instanceof CodexTimeoutError) {
          return resultWarning("timeout", "Local Codex review exceeded its configured time limit.");
        }
        if (error instanceof InvalidCodexOutputError) {
          return resultWarning("invalid_output", "Local Codex returned disallowed activity or invalid review output.");
        }
        if (error instanceof PrivateImageError) {
          return resultWarning("unavailable", "The selected private image could not be prepared for review.");
        }
        return resultWarning("unavailable", "The local Codex reviewer could not complete this review.");
      } finally {
        clearTimeout(timeout);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
