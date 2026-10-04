import { z } from "zod";
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export interface ModelCapabilities {
  responses: boolean;
  text: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  efforts: readonly ReasoningEffort[];
}
export type CapabilityRegistry = Readonly<Record<string, Readonly<Record<string, ModelCapabilities>>>>;
export type ReviewEnvironment = Readonly<Record<string, string | undefined>>;
export type ReviewPass =
  | {
      status: "unavailable";
      code: string;
    }
  | {
      status: "ready";
      provider: "openai" | "codex";
      model: string;
      apiKey?: string;
      effort?: ReasoningEffort;
      capabilities: ModelCapabilities;
    };
export type ReviewConfig =
  | {
      status: "disabled";
    }
  | {
      status: "unavailable";
      code: string;
    }
  | {
      status: "enabled";
      mode: "unified" | "split";
      text: ReviewPass;
      image: ReviewPass;
      final: ReviewPass;
    };
const capabilitySchema = z
  .object({
    responses: z.boolean(),
    text: z.boolean(),
    structuredOutput: z.boolean(),
    imageInput: z.boolean(),
    efforts: z.array(z.enum(reasoningEfforts)).max(7),
  })
  .strict();
const declarationsSchema = z.record(
  z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value === value.trim(), "IDs must be exact"),
  z.record(
    z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value === value.trim(), "IDs must be exact"),
    capabilitySchema,
  ),
);
// Unknown model IDs require an explicit server developer capability declaration.
export function resolveReviewConfig(raw: ReviewEnvironment, registry: CapabilityRegistry = {}): ReviewConfig {
  const value = (key: string) => raw[key]?.trim() || undefined;
  const enabled = value("DATA_REVIEW_ENABLED");
  if (enabled === "false") return { status: "disabled" };
  if (enabled && enabled !== "true") return { status: "unavailable", code: "invalid_enabled" };
  const mode = value("DATA_REVIEW_MODE") ?? "unified";
  if (mode !== "unified" && mode !== "split") return { status: "unavailable", code: "invalid_mode" };
  if (
    mode === "unified" &&
    ["TEXT", "IMAGE"].some((pass) =>
      ["PROVIDER", "MODEL", "REASONING_EFFORT"].some((field) => value(`DATA_REVIEW_${pass}_${field}`)),
    )
  )
    return { status: "unavailable", code: "incompatible_overrides" };
  let declarations: CapabilityRegistry = {};
  const declaration = value("DATA_REVIEW_CAPABILITIES");
  if (declaration) {
    try {
      declarations = declarationsSchema.parse(JSON.parse(declaration));
    } catch {
      return { status: "unavailable", code: "invalid_capabilities" };
    }
  }
  const defaultProvider = value("DATA_REVIEW_PROVIDER") ?? "openai";
  const defaultModel = value("DATA_REVIEW_MODEL") ?? value("OPENAI_INSIGHT_MODEL");
  const defaultEffort = value("DATA_REVIEW_REASONING_EFFORT");
  const resolve = (pass: "TEXT" | "IMAGE"): ReviewPass => {
    const unavailable = (code: string): ReviewPass => ({ status: "unavailable", code });
    const provider = (mode === "split" ? value(`DATA_REVIEW_${pass}_PROVIDER`) : undefined) ?? defaultProvider;
    const model = (mode === "split" ? value(`DATA_REVIEW_${pass}_MODEL`) : undefined) ?? defaultModel;
    const effort = (mode === "split" ? value(`DATA_REVIEW_${pass}_REASONING_EFFORT`) : undefined) ?? defaultEffort;
    if (provider !== "openai" && provider !== "codex") return unavailable("unsupported_provider");
    const apiKey = provider === "openai" ? value("OPENAI_API_KEY") : undefined;
    if (provider === "openai" && !apiKey) return unavailable("missing_credentials");
    if (!model) return unavailable("missing_model");
    const capabilities = declarations[provider]?.[model] ?? registry[provider]?.[model];
    if (!capabilities) return unavailable("unknown_model");
    if (
      (provider === "openai" && !capabilities.responses) ||
      !capabilities.text ||
      !capabilities.structuredOutput ||
      (pass === "IMAGE" && !capabilities.imageInput)
    )
      return unavailable("unsupported_capability");
    if (effort && !capabilities.efforts.includes(effort as ReasoningEffort))
      return unavailable("unsupported_reasoning");
    return {
      status: "ready",
      provider,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(effort ? { effort: effort as ReasoningEffort } : {}),
      capabilities,
    };
  };
  const text = resolve("TEXT");
  return { status: "enabled", mode, text, image: resolve("IMAGE"), final: text };
}
