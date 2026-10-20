import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import OpenAI from "openai";
import nextEnv from "@next/env";
import { z } from "zod";
import { createInsightImageCapabilityVerifier } from "@/insights/image-capability";
import { resolveReviewConfig, type ReviewEnvironment } from "@/config/review";
import { createDataReviewer, ReviewInputSchema, ReviewResultSchema } from "@/insights/provider";
import type { ReviewInput, ReviewPass, ReviewResult } from "@/insights/types";
import { createReviewPassPins, type ReviewPassPin } from "@/server/repositories/review-executions";
import { acceptedInsightImages } from "@/insights/prompt";
import { reviewerEvaluationCases, type ReviewerEvaluationCase } from "../tests/fixtures/reviewer-evaluations";

const RatingSchema = z.number().int().min(1).max(5);
const ScoreSchema = z.object({
  fixtureId: z.string().min(1).max(128),
  variant: z.enum(["baseline", "candidate"]),
  support: RatingSchema,
  relevance: RatingSchema,
  vehicleJudgment: RatingSchema,
  language: RatingSchema,
  reviewer: z.string().max(128).optional(),
  notes: z.string().max(2_000).optional(),
}).strict();
const ScoreFileSchema = z.object({ scores: z.array(ScoreSchema).min(1) }).strict();
const ImageCapabilityFileSchema = z.object({ capability: z.unknown() }).strict();

export type EvaluationScore = z.infer<typeof ScoreSchema>;
type RatingName = "support" | "relevance" | "vehicleJudgment" | "language";
type Variant = "baseline" | "candidate";
export interface EvaluationSummary {
  scoredFixtures: Record<Variant, number>;
  pairedFixtureCount: number;
  averages: Record<Variant, Record<RatingName, number | null>>;
  pairedMeanDifference: Record<RatingName, number | null>;
  interpretation: string;
}

export interface EvaluationRunRow {
  fixtureId: string;
  label: string;
  category: ReviewerEvaluationCase["category"];
  variant: Variant;
  provider: string;
  model: string;
  locale: string;
  pass: ReviewPass;
  promptHash: string;
  status: "returned" | "controlled_unavailable" | "skipped_missing_image_capability";
  schemaAccepted: boolean | null;
  elapsedMs: number | null;
  result: ReviewResult | null;
}

interface RunOptions {
  baselineModel: string;
  candidateModel: string;
  provider: string;
  output: string;
  run: boolean;
  fixtureId?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseEvaluationScores(value: unknown): EvaluationScore[] {
  const parsed = ScoreFileSchema.parse(value);
  const fixtureIds = new Set(reviewerEvaluationCases.map((item) => item.id));
  const seen = new Set<string>();
  for (const score of parsed.scores) {
    if (!fixtureIds.has(score.fixtureId)) fail(`Unknown reviewer evaluation fixture: ${score.fixtureId}`);
    const fixture = reviewerEvaluationCases.find((item) => item.id === score.fixtureId);
    if (fixture?.control) fail(`The controlled failure fixture is not scored as model quality: ${score.fixtureId}`);
    const key = `${score.fixtureId}:${score.variant}`;
    if (seen.has(key)) fail(`Duplicate human score row: ${key}`);
    seen.add(key);
  }
  return parsed.scores;
}

function mean(rows: readonly EvaluationScore[], key: RatingName): number | null {
  if (rows.length === 0) return null;
  const value = rows.reduce((total, row) => total + row[key], 0) / rows.length;
  return Math.round(value * 100) / 100;
}

function averages(rows: readonly EvaluationScore[]): Record<RatingName, number | null> {
  return {
    support: mean(rows, "support"),
    relevance: mean(rows, "relevance"),
    vehicleJudgment: mean(rows, "vehicleJudgment"),
    language: mean(rows, "language"),
  };
}

export function validateScoresAgainstResults(
  scores: readonly EvaluationScore[],
  rows: readonly EvaluationRunRow[],
): void {
  const resultsByPair = new Map(rows.map((row) => [`${row.fixtureId}:${row.variant}`, row]));
  for (const score of scores) {
    const key = `${score.fixtureId}:${score.variant}`;
    const row = resultsByPair.get(key);
    if (!row || row.status !== "returned" || row.schemaAccepted !== true || row.result === null) {
      fail(`Score ${key} has no returned, schema-valid result in the referenced run.`);
    }
  }
}

export function summarizeEvaluationScores(scores: readonly EvaluationScore[]): EvaluationSummary {
  const baseline = scores.filter((score) => score.variant === "baseline");
  const candidate = scores.filter((score) => score.variant === "candidate");
  const baselineByFixture = new Map(baseline.map((score) => [score.fixtureId, score]));
  const candidateByFixture = new Map(candidate.map((score) => [score.fixtureId, score]));
  const pairedIds = [...baselineByFixture.keys()].filter((fixtureId) => candidateByFixture.has(fixtureId));
  const pairedDifferences = (key: RatingName): number | null => {
    if (pairedIds.length === 0) return null;
    const total = pairedIds.reduce((sum, fixtureId) => {
      return sum + candidateByFixture.get(fixtureId)![key] - baselineByFixture.get(fixtureId)![key];
    }, 0);
    return Math.round((total / pairedIds.length) * 100) / 100;
  };

  return {
    scoredFixtures: { baseline: baseline.length, candidate: candidate.length },
    pairedFixtureCount: pairedIds.length,
    averages: { baseline: averages(baseline), candidate: averages(candidate) },
    pairedMeanDifference: {
      support: pairedDifferences("support"),
      relevance: pairedDifferences("relevance"),
      vehicleJudgment: pairedDifferences("vehicleJudgment"),
      language: pairedDifferences("language"),
    },
    interpretation: "These are explicit human ratings. A valid output schema does not establish factual support or semantic correctness.",
  };
}

function splitArguments(args: readonly string[]): { command: string; values: Map<string, string>; flags: Set<string> } {
  const command = args[0] ?? "help";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    if (arg === "--run") {
      flags.add(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  return { command, values, flags };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) fail(`Missing ${key}`);
  return value;
}

function evaluationEnvironment(base: NodeJS.ProcessEnv, model: string, provider: string): ReviewEnvironment {
  const env: Record<string, string | undefined> = { ...base };
  for (const pass of ["TEXT", "IMAGE"]) {
    delete env[`DATA_REVIEW_${pass}_PROVIDER`];
    delete env[`DATA_REVIEW_${pass}_MODEL`];
    delete env[`DATA_REVIEW_${pass}_REASONING_EFFORT`];
  }
  env.DATA_REVIEW_ENABLED = "true";
  env.DATA_REVIEW_MODE = "unified";
  env.DATA_REVIEW_PROVIDER = provider;
  env.DATA_REVIEW_MODEL = model;
  return env;
}

function readyPins(env: ReviewEnvironment, locale: ReviewerEvaluationCase["locale"]): Record<ReviewPass, ReviewPassPin> {
  const config = resolveReviewConfig(env);
  if (config.status !== "enabled") fail(`Review configuration unavailable (${config.status === "unavailable" ? config.code : "disabled"}).`);
  for (const pass of ["text", "image", "final"] as const) {
    if (config[pass].status !== "ready") fail(`Model configuration cannot run the ${pass} evaluation pass (${config[pass].code}).`);
  }
  return createReviewPassPins(config, locale).passes;
}

function imageBoundary(env: NodeJS.ProcessEnv) {
  if (!env.ANALYSIS_COOKIE_SECRET || !env.NEXT_PUBLIC_SUPABASE_URL) return undefined;
  let origin: string;
  try {
    origin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
  } catch {
    return undefined;
  }
  return {
    imageUrlVerifier: createInsightImageCapabilityVerifier(env.ANALYSIS_COOKIE_SECRET),
    allowedStorageOrigins: [origin],
  };
}

function inputForImageFixture(
  fixture: ReviewerEvaluationCase,
  rawCapability: string | undefined,
  env: NodeJS.ProcessEnv,
): ReviewInput | null {
  if (!rawCapability) return null;
  const parsed = ImageCapabilityFileSchema.parse(JSON.parse(rawCapability)) as { capability: unknown };
  const boundary = imageBoundary(env);
  if (!boundary) fail("An image boundary requires ANALYSIS_COOKIE_SECRET and NEXT_PUBLIC_SUPABASE_URL.");
  const input = fixture.input;
  const supplied = boundary.imageUrlVerifier.verifyServerIssuedCapability(parsed.capability);
  if (!supplied) fail("The evaluation image capability is invalid or expired.");
  const imageId = supplied.evidenceId;
  const evidence = input.evidence.map((item) => item.id === input.imageEvidenceId ? { ...item, id: imageId } : item);
  const sourceRecords = input.sourceRecords.map((item) => item.evidenceId === input.imageEvidenceId ? { ...item, evidenceId: imageId } : item);
  const evaluationInput: ReviewInput = {
    ...input,
    analysisId: supplied.analysisId,
    runId: `${input.runId}-image-reference`,
    imageEvidenceId: imageId,
    evidence,
    sourceRecords,
    images: [{ evidenceId: imageId, capability: parsed.capability }],
  };
  const parsedInput = ReviewInputSchema.safeParse(evaluationInput);
  if (!parsedInput.success) fail("The reference image does not match the evaluation input contract.");
  const accepted = acceptedInsightImages({
    analysisId: parsedInput.data.analysisId,
    images: parsedInput.data.images,
  }, boundary);
  if (accepted.length !== 1 || accepted[0]?.evidenceId !== imageId) fail("The reference image is not an accepted private image capability.");
  return parsedInput.data;
}

function validateOptions(command: string, values: Map<string, string>, flags: Set<string>): RunOptions {
  if (!flags.has("--run")) fail("No model calls were made. Add --run only when you intend to make provider requests.");
  const baselineModel = required(values, "--baseline");
  const candidateModel = required(values, "--candidate");
  if (baselineModel === candidateModel) fail("Baseline and candidate model IDs must differ.");
  const provider = values.get("--provider") ?? process.env.DATA_REVIEW_PROVIDER ?? "openai";
  const output = required(values, "--output");
  if (command !== "run") fail(`Unknown command: ${command}`);
  const fixtureId = values.get("--fixture");
  if (fixtureId && !reviewerEvaluationCases.some(item => item.id === fixtureId)) fail(`Unknown fixture: ${fixtureId}`);
  return { baselineModel, candidateModel, provider, output, run: true, ...(fixtureId ? {fixtureId} : {}) };
}

async function runEvaluation(options: RunOptions): Promise<{ rows: EvaluationRunRow[]; createdAt: string }> {
  if (!options.run) fail("Provider calls require the explicit --run flag.");
  if (!["openai", "codex"].includes(options.provider)) fail(`Unsupported evaluation provider: ${options.provider}.`);
  if (options.provider === "openai" && !process.env.OPENAI_API_KEY) fail("OPENAI_API_KEY is required; no model calls were made.");
  const variants: Array<{ variant: Variant; model: string; env: ReviewEnvironment }> = [
    { variant: "baseline", model: options.baselineModel, env: evaluationEnvironment(process.env, options.baselineModel, options.provider) },
    { variant: "candidate", model: options.candidateModel, env: evaluationEnvironment(process.env, options.candidateModel, options.provider) },
  ];
  const configByVariant = variants.map(({ env, model, variant }) => ({ variant, model, env, config: resolveReviewConfig(env) }));
  const invalidConfig = configByVariant.find(({ config }) => config.status !== "enabled"
    || config.text.status !== "ready" || config.image.status !== "ready" || config.final.status !== "ready");
  if (invalidConfig) {
    const code = invalidConfig.config.status === "enabled"
      ? [invalidConfig.config.text, invalidConfig.config.image, invalidConfig.config.final].find((pass) => pass.status !== "ready")?.code
      : invalidConfig.config.status === "unavailable" ? invalidConfig.config.code : "disabled";
    fail(`${invalidConfig.variant} model configuration is not ready (${code ?? "unknown"}); no model calls were made.`);
  }

  const imageCase = reviewerEvaluationCases.find((item) => item.category === "image_observation")!;
  const imageInput = inputForImageFixture(imageCase, process.env.DATA_REVIEW_EVALUATION_IMAGE, process.env);
  const boundary = imageBoundary(process.env) ?? {};
  const reviewers = new Map<string, ReturnType<typeof createDataReviewer>>();
  const clients = new Map<string, OpenAI>();
  const pinsByVariantAndLocale = new Map<string, Record<ReviewPass, ReviewPassPin>>();
  const rows: EvaluationRunRow[] = [];
  const cases = options.fixtureId ? reviewerEvaluationCases.filter(item => item.id === options.fixtureId) : reviewerEvaluationCases;
  const plannedCalls = cases.filter((item) => item.category !== "reviewer_failure"
    && (item.category !== "image_observation" || imageInput !== null)).length * variants.length;
  process.stdout.write(`Starting ${plannedCalls} provider requests for ${variants.length} model configurations.\n`);

  for (const fixture of cases) {
    for (const { variant, model, env } of variants) {
      const pinsKey = `${variant}:${fixture.locale}`;
      let pins = pinsByVariantAndLocale.get(pinsKey);
      if (!pins) {
        pins = readyPins(env, fixture.locale);
        pinsByVariantAndLocale.set(pinsKey, pins);
      }
      const basePin = pins[fixture.pass];
      const pin = fixture.control === "force_unavailable"
        ? { ...basePin, availability: "unavailable" as const, code: "evaluation_control" }
        : basePin;
      const clientKey = `${variant}:${model}`;
      let reviewer = fixture.control ? undefined : reviewers.get(`${clientKey}:${fixture.pass}:${fixture.locale}`);
      if (!fixture.control && !reviewer) {
        let openAIClient = clients.get(clientKey);
        if (options.provider === "openai" && !openAIClient) {
          openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          clients.set(clientKey, openAIClient);
        }
        const dataReviewer = createDataReviewer(pin, env, boundary, openAIClient);
        reviewer = dataReviewer;
        reviewers.set(`${clientKey}:${fixture.pass}:${fixture.locale}`, reviewer);
      }
      if (fixture.control) reviewer = createDataReviewer(pin, env, boundary);

      const input = fixture.category === "image_observation"
        ? imageInput ?? fixture.input
        : fixture.input;
      const missingImage = fixture.category === "image_observation" && imageInput === null;
      if (missingImage) {
        rows.push({
          fixtureId: fixture.id,
          label: fixture.label,
          category: fixture.category,
          variant,
          provider: options.provider,
          model,
          locale: fixture.locale,
          pass: fixture.pass,
          promptHash: basePin.prompt.hash,
          status: "skipped_missing_image_capability",
          schemaAccepted: null,
          elapsedMs: null,
          result: null,
        });
        continue;
      }

      const parsedInput = ReviewInputSchema.safeParse(input);
      if (!parsedInput.success) fail(`Fixture ${fixture.id} does not satisfy the review input contract.`);
      const startedAt = Date.now();
      let result: ReviewResult;
      try {
        result = await reviewer!.review(parsedInput.data);
      } catch {
        result = { schemaVersion: 1, observations: [], warnings: [{ code: "unavailable", message: "Evaluation runner caught a reviewer exception." }] };
      }
      const outputIsSchemaValid = ReviewResultSchema.safeParse(result).success;
      rows.push({
        fixtureId: fixture.id,
        label: fixture.label,
        category: fixture.category,
        variant,
        provider: options.provider,
        model,
        locale: fixture.locale,
        pass: fixture.pass,
        promptHash: basePin.prompt.hash,
        status: fixture.control ? "controlled_unavailable" : "returned",
        schemaAccepted: outputIsSchemaValid,
        elapsedMs: Date.now() - startedAt,
        result: outputIsSchemaValid ? result : null,
      });
    }
  }
  return { rows, createdAt: new Date().toISOString() };
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function humanReviewSheet(rows: readonly EvaluationRunRow[]): string {
  const sections = reviewerEvaluationCases.map((fixture) => {
    const baseline = rows.find((row) => row.fixtureId === fixture.id && row.variant === "baseline");
    const candidate = rows.find((row) => row.fixtureId === fixture.id && row.variant === "candidate");
    const render = (row: EvaluationRunRow | undefined) => {
      if (!row) return "No output row.";
      if (row.status === "skipped_missing_image_capability") return "Skipped: provide a valid reference image capability to evaluate this case.";
      const result = row.result;
      if (!result) return "No schema-valid result was recorded.";
      const observations = result.observations.length === 0 ? "No observations." : result.observations.map((item) =>
        `- **${markdownCell(item.severity)} — ${markdownCell(item.title)}** (${markdownCell(item.evidenceIds.join(", "))})\n  ${markdownCell(item.explanation)}\n  Action: ${markdownCell(item.recommendedAction.title)} — ${markdownCell(item.recommendedAction.instructions)}`,
      ).join("\n");
      const warnings = result.warnings.length ? `\nWarnings: ${result.warnings.map((warning) => `${markdownCell(warning.code)} — ${markdownCell(warning.message)}`).join("; ")}` : "\nWarnings: none.";
      return `Model: ${markdownCell(row.model)}; schemaAccepted: ${row.schemaAccepted}; status: ${row.status}.\n\n${observations}${warnings}`;
    };
    const rubric = fixture.rubric.map((point) => `- ${point}`).join("\n");
    const scoreTable = fixture.control
      ? "This is a forced unavailable control; do not include it in model-quality scores."
      : "| Variant | Support (1–5) | Relevance (1–5) | Vehicle judgment (1–5) | Language (1–5) | Notes |\n|---|---:|---:|---:|---:|---|\n| baseline |  |  |  |  |  |\n| candidate |  |  |  |  |  |";
    return `## ${fixture.id}\n\n${fixture.label} · ${fixture.category} · ${fixture.locale}/${fixture.pass}\n\n**Human rubric**\n\n${rubric}\n\n**Baseline**\n\n${render(baseline)}\n\n**Candidate**\n\n${render(candidate)}\n\n**Ratings**\n\n${scoreTable}`;
  });
  return [
    "# Reviewer evaluation: human scoring sheet",
    "",
    "Rate support, relevance, vehicle judgment, and language from 1 (poor) to 5 (strong). Record the paired scores in a separate JSON score file for the summary command.",
    "A schema-valid response is only structurally valid; it is not evidence of factual support or semantic correctness.",
    "",
    ...sections,
    "",
  ].join("\n");
}

async function writeEvaluation(output: string, result: { rows: EvaluationRunRow[]; createdAt: string }): Promise<void> {
  const outputPath = resolve(process.cwd(), output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, ...result }, null, 2)}\n`, "utf8");
  await writeFile(`${outputPath}.human-review.md`, humanReviewSheet(result.rows), "utf8");
  process.stdout.write(`Wrote evaluation results to ${outputPath}\n`);
  process.stdout.write(`Wrote human scoring sheet to ${outputPath}.human-review.md\n`);
}

async function summarizeCommand(values: Map<string, string>): Promise<void> {
  const resultsPath = resolve(process.cwd(), required(values, "--results"));
  const scoresPath = resolve(process.cwd(), required(values, "--scores"));
  const resultDoc = JSON.parse(await readFile(resultsPath, "utf8")) as { schemaVersion?: number; rows?: EvaluationRunRow[] };
  if (resultDoc.schemaVersion !== 1 || !resultDoc.rows?.length) fail("The results file has no supported evaluation rows.");
  const scores = parseEvaluationScores(JSON.parse(await readFile(scoresPath, "utf8")));
  validateScoresAgainstResults(scores, resultDoc.rows);
  const summary = summarizeEvaluationScores(scores);
  const output = values.get("--output");
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    const outputPath = resolve(process.cwd(), output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, text, "utf8");
    process.stdout.write(`Wrote human-rating summary to ${outputPath}\n`);
  } else {
    process.stdout.write(text);
  }
}

function help(): void {
  process.stdout.write([
    "Developer-only reviewer evaluation runner",
    "",
    "Run provider comparisons only with an explicit --run flag:",
    "  pnpm tsx scripts/evaluate-reviewer.ts run --baseline MODEL_ID --candidate MODEL_ID --output /path/to/results.json --run",
    "",
    "Summarize explicit human ratings:",
    "  pnpm tsx scripts/evaluate-reviewer.ts summarize --results /path/to/results.json --scores /path/to/scores.json",
    "",
    "The runner forces unified mode and one provider for both model IDs. Model calls require DATA_REVIEW_CAPABILITIES. OpenAI requires OPENAI_API_KEY; --provider codex uses the local Codex login.",
    "",
  ].join("\n"));
}

async function main(): Promise<void> {
  const { command, values, flags } = splitArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || values.has("--help")) {
    help();
    return;
  }
  if (command === "summarize") {
    await summarizeCommand(values);
    return;
  }
  nextEnv.loadEnvConfig(process.cwd());
  const options = validateOptions(command, values, flags);
  const result = await runEvaluation(options);
  await writeEvaluation(options.output, result);
}

if (process.argv[1]?.endsWith("evaluate-reviewer.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Evaluation runner failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
