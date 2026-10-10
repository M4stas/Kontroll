import type { ReasoningEffort } from "@/config/review";
import type OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import {
  INSIGHT_TIMEOUT_MS,
  InsightResultSchema,
  type InsightInput,
  type InsightImageBoundaryOptions,
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

function sourcesMatch(left: InsightResult["sources"][number], right: InsightResult["sources"][number]): boolean {
  return left.id === right.id
    && left.url === right.url
    && left.title === right.title
    && left.sourceClass === right.sourceClass
    && left.applicability === right.applicability
    && left.confidence === right.confidence
    && left.observation === right.observation;
}

function validatedResult(
  input: InsightInput,
  outputText: string,
  acceptedImageEvidenceIds: ReadonlySet<string>,
): InsightResult | "malformed" | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(outputText);
  } catch {
    return "malformed";
  }

  const parsed = InsightResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const inputEvidenceIds = new Set(input.evidence.map((evidence) => evidence.id).filter(Boolean));
  const sourcesById = new Map(parsed.data.sources.map((source) => [source.id, source]));
  const sourceIds = new Set(sourcesById.keys());
  const validEvidenceIds = new Set([...inputEvidenceIds, ...sourceIds]);

  const sourceIdsAreUnique = sourceIds.size === parsed.data.sources.length
    && parsed.data.sources.every((source) => {
      const evidence = input.evidence.find((item) => item.id === source.id);
      return evidence !== undefined
        && source.url === (evidence.sourceUrl ?? `urn:kontroll:evidence:${evidence.id}`)
        && source.sourceClass === evidence.sourceClass
        && source.title === evidence.claim
        && source.applicability === "unverified_input"
        && source.confidence <= evidence.confidence;
    });
  const findingsHaveValidEvidence = parsed.data.findings.every((finding) =>
    finding.evidenceIds.every((evidenceId) => validEvidenceIds.has(evidenceId)));
  const proposalSourcesAreResolvable = [...parsed.data.findings, ...parsed.data.imageObservations].every(
    (proposal) => {
      const registeredSource = sourcesById.get(proposal.source.id);
      return registeredSource !== undefined && sourcesMatch(registeredSource, proposal.source);
    },
  );
  const findingsCiteTheirProvenance = parsed.data.findings.every((finding) =>
    finding.evidenceIds.includes(finding.source.id));
  const imageObservationsHaveValidEvidence = parsed.data.imageObservations.every((observation) =>
    acceptedImageEvidenceIds.has(observation.imageEvidenceId));

  return sourceIdsAreUnique
    && findingsHaveValidEvidence
    && proposalSourcesAreResolvable
    && findingsCiteTheirProvenance
    && imageObservationsHaveValidEvidence
    ? parsed.data
    : undefined;
}

export class OpenAIInsightProvider implements InsightProvider {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly imageBoundary: InsightImageBoundaryOptions = {},
    private readonly effort?: ReasoningEffort,
  ) {}

  async enrich(input: InsightInput): Promise<InsightResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const acceptedImages = acceptedInsightImages(input, this.imageBoundary);
      const request: Responses.ResponseCreateParamsNonStreaming = {
        model: this.model,
        ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
        input: buildInsightInput(input, acceptedImages),
        text: {
          format: {
            type: "json_schema",
            name: "used_car_insight",
            strict: true,
            schema: insightResultJsonSchema,
          },
        },
      };

      const response = await Promise.race([
        this.client.responses.create(request, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new InsightTimeoutError());
          }, INSIGHT_TIMEOUT_MS);
        }),
      ]);

      if (hasRefusal(response)) return warning("refusal", "OpenAI declined this enrichment request.");
      if (!response.output_text) return warning("malformed_response", "OpenAI returned no structured output.");

      const result = validatedResult(
        input,
        response.output_text,
        new Set(acceptedImages.map((image) => image.evidenceId)),
      );
      if (result === "malformed") {
        return warning("malformed_response", "OpenAI returned malformed structured output.");
      }
      return result ?? warning("schema_invalid", "OpenAI output did not satisfy the insight evidence contract.");
    } catch (error) {
      if (error instanceof InsightTimeoutError) {
        return warning("timeout", "OpenAI enrichment exceeded the 75-second time limit.");
      }
      return warning("request_failed", "OpenAI enrichment was unavailable; the deterministic report remains usable.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

