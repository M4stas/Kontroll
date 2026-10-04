import { describe, expect, it } from "vitest";
import { ReviewInputSchema } from "@/insights/provider";
import { reviewerEvaluationCases } from "../../fixtures/reviewer-evaluations";
import { parseEvaluationScores, summarizeEvaluationScores, validateScoresAgainstResults } from "../../../scripts/evaluate-reviewer";

describe("reviewer evaluation fixtures", () => {
  it("covers the planned cases with bounded, contract-shaped inputs", () => {
    const categories = new Set(reviewerEvaluationCases.map((item) => item.category));
    expect(categories).toEqual(new Set([
      "normal_listing",
      "missing_listing",
      "conflicting_listing",
      "image_observation",
      "seller_update",
      "known_id_semantic_misuse",
      "language_quality",
      "prompt_injection",
      "fabricated_citation",
      "reviewer_failure",
    ]));

    for (const item of reviewerEvaluationCases) {
      const parsed = ReviewInputSchema.safeParse(item.input);
      expect(parsed.success, item.id).toBe(true);
      expect(item.input.pass).toBe(item.pass);
      expect(item.rubric.length).toBeGreaterThan(0);
      expect(JSON.stringify(item.input).length).toBeLessThan(40_000);
    }
  });

  it("only computes paired averages from explicit 1-to-5 human ratings", () => {
    const scores = parseEvaluationScores({
      scores: [
        { fixtureId: "normal-listing-en", variant: "baseline", support: 3, relevance: 4, vehicleJudgment: 3, language: 4 },
        { fixtureId: "normal-listing-en", variant: "candidate", support: 5, relevance: 4, vehicleJudgment: 5, language: 5 },
        { fixtureId: "et-listing", variant: "baseline", support: 4, relevance: 3, vehicleJudgment: 4, language: 3 },
      ],
    });

    const summary = summarizeEvaluationScores(scores);
    expect(summary.scoredFixtures).toEqual({ baseline: 2, candidate: 1 });
    expect(summary.pairedFixtureCount).toBe(1);
    expect(summary.averages.baseline).toEqual({ support: 3.5, relevance: 3.5, vehicleJudgment: 3.5, language: 3.5 });
    expect(summary.averages.candidate).toEqual({ support: 5, relevance: 4, vehicleJudgment: 5, language: 5 });
    expect(summary.pairedMeanDifference).toEqual({ support: 2, relevance: 0, vehicleJudgment: 2, language: 1 });
  });

  it("rejects invalid or duplicate score rows instead of treating schema acceptance as a score", () => {
    expect(() => parseEvaluationScores({
      scores: [{ fixtureId: "normal-listing-en", variant: "candidate", support: 6, relevance: 4, vehicleJudgment: 4, language: 4 }],
    })).toThrow();
    expect(() => parseEvaluationScores({
      scores: [
        { fixtureId: "normal-listing-en", variant: "candidate", support: 4, relevance: 4, vehicleJudgment: 4, language: 4 },
        { fixtureId: "normal-listing-en", variant: "candidate", support: 5, relevance: 4, vehicleJudgment: 5, language: 4 },
      ],
    })).toThrow();
  });
  it("rejects human scores for skipped cases that have no comparable model output", () => {
    const scores = parseEvaluationScores({
      scores: [{ fixtureId: "wheel-image-observation", variant: "baseline", support: 4, relevance: 4, vehicleJudgment: 4, language: 4 }],
    });
    expect(() => validateScoresAgainstResults(scores, [{
      fixtureId: "wheel-image-observation",
      label: "Single-image visual observation",
      category: "image_observation",
      variant: "baseline",
      provider: "openai",
      model: "model-a",
      locale: "en",
      pass: "image",
      promptHash: "hash",
      status: "skipped_missing_image_capability",
      schemaAccepted: null,
      elapsedMs: null,
      result: null,
    }])).toThrow();
  });

});
