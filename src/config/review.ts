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

const productionImageProvider = "codex" as const;
const productionImageModel = "gpt-6-luna";
const productionImageCeiling: ReasoningEffort = "xhigh";

export function isProductionImageSettingsAllowed(settings: {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): boolean {
  const { provider, model, reasoningEffort } = settings;
  if (provider !== productionImageProvider || model !== productionImageModel || !reasoningEffort) return false;
  if (!reasoningEfforts.includes(reasoningEffort as ReasoningEffort)) return false;
  return reasoningEfforts.indexOf(reasoningEffort as ReasoningEffort) <= reasoningEfforts.indexOf(productionImageCeiling);
}

/**
 * Resolve server production review settings while enforcing the approved image
 * model and reasoning ceiling. Text and final passes retain generic resolution.
 */
export function resolveProductionReviewConfig(raw: ReviewEnvironment, registry: CapabilityRegistry = {}): ReviewConfig {
  const value = (key: string) => raw[key]?.trim() || undefined;
  if (value("DATA_REVIEW_ENABLED") === "false") return { status: "disabled" };

  // Image provider/model settings are fixed in production. Resolve the text pass
  // from the caller's settings without allowing those image settings to change it.
  const textEnvironment = { ...raw };
  delete textEnvironment.DATA_REVIEW_IMAGE_PROVIDER;
  delete textEnvironment.DATA_REVIEW_IMAGE_MODEL;
  delete textEnvironment.DATA_REVIEW_IMAGE_REASONING_EFFORT;
  const textConfig = resolveReviewConfig(textEnvironment, registry);
  if (textConfig.status !== "enabled") return textConfig;

  const imageEffortValue = value("DATA_REVIEW_IMAGE_REASONING_EFFORT") ?? productionImageCeiling;
  const imageEffort = reasoningEfforts.includes(imageEffortValue as ReasoningEffort)
    ? (imageEffortValue as ReasoningEffort)
    : undefined;
  const overCeiling = !isProductionImageSettingsAllowed({
    provider: productionImageProvider,
    model: productionImageModel,
    reasoningEffort: imageEffort,
  });
  const unavailable = (code: string): ReviewPass => ({ status: "unavailable", code });
  let image: ReviewPass;

  if (overCeiling) {
    image = unavailable("unsupported_reasoning");
  } else {
    let declaredCapabilities: CapabilityRegistry = {};
    const declaration = value("DATA_REVIEW_CAPABILITIES");
    if (declaration) {
      try {
        declaredCapabilities = declarationsSchema.parse(JSON.parse(declaration));
      } catch {
        return { status: "unavailable", code: "invalid_capabilities" };
      }
    }
    const declaredImageCapability = declaredCapabilities[productionImageProvider]?.[productionImageModel];

    if (!declaredImageCapability) {
      image = unavailable("unknown_model");
    } else if (!declaredImageCapability.efforts.includes(productionImageCeiling)) {
      image = unavailable("unsupported_reasoning");
    } else {
      const productionEnvironment: ReviewEnvironment = {
        ...raw,
        DATA_REVIEW_MODE: "split",
        DATA_REVIEW_IMAGE_PROVIDER: productionImageProvider,
        DATA_REVIEW_IMAGE_MODEL: productionImageModel,
        DATA_REVIEW_IMAGE_REASONING_EFFORT: imageEffort,
      };
      const productionConfig = resolveReviewConfig(productionEnvironment, registry);
      if (productionConfig.status !== "enabled") return productionConfig;
      image = productionConfig.image;
    }
  }

  return {
    status: "enabled",
    mode: "split",
    text: textConfig.text,
    image,
    final: textConfig.text,
  };
}
