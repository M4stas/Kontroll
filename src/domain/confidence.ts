import type { ConfidenceBand, ConfidenceInput } from "@/domain/analysis";
import { ConfidenceInputSchema } from "@/domain/schemas";

export type { ConfidenceInput } from "@/domain/analysis";

export function calculateConfidence(input: ConfidenceInput): ConfidenceBand {
  const validatedInput = ConfidenceInputSchema.parse(input);
  const floor = Math.min(
    validatedInput.identity,
    validatedInput.coverage,
    validatedInput.agreement,
    validatedInput.freshness,
  );

  if (floor >= 0.8) {
    return "high";
  }

  if (floor >= 0.55) {
    return "moderate";
  }

  return "low";
}
