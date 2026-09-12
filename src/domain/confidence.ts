import type { ConfidenceBand, ConfidenceInput } from "@/domain/analysis";

export type { ConfidenceInput } from "@/domain/analysis";

export function calculateConfidence(input: ConfidenceInput): ConfidenceBand {
  const floor = Math.min(input.identity, input.coverage, input.agreement, input.freshness);

  if (floor >= 0.8) {
    return "high";
  }

  if (floor >= 0.55) {
    return "moderate";
  }

  return "low";
}
