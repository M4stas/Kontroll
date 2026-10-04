import { expect, it } from "vitest";
import { resolveReviewConfig } from "@/config/review";
const caps = {
  codex: {
    "gpt-6.1-sol": { responses: false, text: true, structuredOutput: true, imageInput: true, efforts: ["medium"] },
  },
} as const;
it("selects the local Codex reviewer without an OpenAI API key", () => {
  const result = resolveReviewConfig(
    { DATA_REVIEW_PROVIDER: "codex", DATA_REVIEW_MODEL: "gpt-6.1-sol", DATA_REVIEW_REASONING_EFFORT: "medium" },
    caps,
  );
  expect(result.status).toBe("enabled");
  if (result.status !== "enabled") throw new Error("Expected enabled reviewer");
  expect(result.text).toMatchObject({ status: "ready", provider: "codex", model: "gpt-6.1-sol", effort: "medium" });
  expect(result.text).not.toHaveProperty("apiKey");
  expect(result.image).toEqual(result.text);
  expect(result.final).toBe(result.text);
});
it("still rejects undeclared Codex models and unsupported image capabilities", () => {
  const unknown = resolveReviewConfig({ DATA_REVIEW_PROVIDER: "codex", DATA_REVIEW_MODEL: "unknown" }, caps);
  expect(unknown).toMatchObject({ status: "enabled", text: { status: "unavailable", code: "unknown_model" } });
  const textOnly = { codex: { text: { ...caps.codex["gpt-6.1-sol"], imageInput: false } } };
  const split = resolveReviewConfig(
    { DATA_REVIEW_PROVIDER: "codex", DATA_REVIEW_MODEL: "text", DATA_REVIEW_MODE: "split" },
    textOnly,
  );
  expect(split).toMatchObject({
    status: "enabled",
    text: { status: "ready" },
    image: { status: "unavailable", code: "unsupported_capability" },
  });
});
