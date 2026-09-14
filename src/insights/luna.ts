import type OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import {
  INSIGHT_TIMEOUT_MS,
  InsightResultSchema,
  type InsightInput,
  type InsightProvider,
  type InsightResult,
  type InsightWarningCode,
  insightResultJsonSchema,
} from "@/insights/provider";
import { acceptedInsightImages, buildInsightInput } from "@/insights/prompt";

class InsightTimeoutError extends Error {}

function warning(code: InsightWarningCode, message: string): InsightResult {
  return {
    schemaVersion: 1,
    sources: [],
    findings: [],
    imageObservations: [],
    warnings: [{ stage: "enrich", code, message }],
  };
}

function hasRefusal(response: OpenAI.Responses.Response): boolean {
  return (response.output ?? []).some((item) => item.type === "message"
    && item.content.some((content) => content.type === "refusal"));
}

function validatedResult(input: InsightInput, outputText: string): InsightResult | "malformed" | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(outputText);
  } catch {
    return "malformed";
  }

  const parsed = InsightResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const inputEvidenceIds = new Set(input.evidence.map((evidence) => evidence.id).filter(Boolean));
  const sourceIds = new Set(parsed.data.sources.map((source) => source.id));
  const validEvidenceIds = new Set([...inputEvidenceIds, ...sourceIds]);
  const acceptedImageEvidenceIds = new Set(acceptedInsightImages(input).map((image) => image.evidenceId));

  const sourceIdsAreUnique = sourceIds.size === parsed.data.sources.length
    && [...sourceIds].every((sourceId) => !inputEvidenceIds.has(sourceId));
  const findingsHaveValidEvidence = parsed.data.findings.every((finding) =>
    finding.evidenceIds.every((evidenceId) => validEvidenceIds.has(evidenceId)));
  const imageObservationsHaveValidEvidence = parsed.data.imageObservations.every((observation) =>
    acceptedImageEvidenceIds.has(observation.imageEvidenceId));

  return sourceIdsAreUnique && findingsHaveValidEvidence && imageObservationsHaveValidEvidence
    ? parsed.data
    : undefined;
}

export class LunaInsightProvider implements InsightProvider {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async enrich(input: InsightInput): Promise<InsightResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request: Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      reasoning: { effort: "high" },
      tools: [{ type: "web_search" }],
      input: buildInsightInput(input),
      text: {
        format: {
          type: "json_schema",
          name: "used_car_insight",
          strict: true,
          schema: insightResultJsonSchema,
        },
      },
    };

    try {
      const response = await Promise.race([
        this.client.responses.create(request, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new InsightTimeoutError());
          }, INSIGHT_TIMEOUT_MS);
        }),
      ]);

      if (hasRefusal(response)) return warning("refusal", "Luna declined this enrichment request.");
      if (!response.output_text) return warning("malformed_response", "Luna returned no structured output.");

      const result = validatedResult(input, response.output_text);
      if (result === "malformed") {
        return warning("malformed_response", "Luna returned malformed structured output.");
      }
      return result ?? warning("schema_invalid", "Luna output did not satisfy the insight evidence contract.");
    } catch (error) {
      if (error instanceof InsightTimeoutError) {
        return warning("timeout", "Luna enrichment exceeded the 75-second time limit.");
      }
      return warning("request_failed", "Luna enrichment was unavailable; the deterministic report remains usable.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
