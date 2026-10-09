import { describe, expect, it } from "vitest";
import { DiagnosticAttemptSchema, DiagnosticReviewSchema } from "@/diagnostics/contracts";
const attempt = {
  id: "attempt",
  number: 1,
  state: "success",
  startedAt: "2026-10-09T12:00:00.000Z",
  completedAt: "2026-10-09T12:00:01.000Z",
  durationMs: 1000,
};
describe("bounded diagnostic contracts", () => {
  it("rejects negative duration and contradictory timestamps/states", () => {
    for (const extra of [
      {
        durationMs: -1,
      },
      {
        completedAt: null,
      },
      {
        completedAt: "2026-10-09T11:59:59.000Z",
      },
      {
        state: "started",
      },
    ])
      expect(
        DiagnosticAttemptSchema.safeParse({
          ...attempt,
          ...extra,
        }).success,
      ).toBe(false);
  });
  it("rejects arbitrary raw warning errors", () =>
    expect(
      DiagnosticAttemptSchema.safeParse({
        ...attempt,
        warningCode: "secret provider error",
      }).success,
    ).toBe(false));
  it("rejects oversized attempt arrays and arbitrary settings", () => {
    const review = {
      key: "text",
      executionId: "execution",
      pass: "text",
      evidenceId: null,
      selected: false,
      state: "complete",
      settings: null,
      attempts: Array(500).fill(attempt),
      durationMs: 1000,
      resultAvailable: true,
      completedAt: attempt.completedAt,
      reusedFrom: null,
      latestAttempt: attempt,
    };
    expect(DiagnosticReviewSchema.safeParse(review).success).toBe(true);
    expect(DiagnosticReviewSchema.safeParse({ ...review, attempts: Array(501).fill(attempt) }).success).toBe(false);
    expect(
      DiagnosticReviewSchema.safeParse({
        ...review,
        settings: {
          provider: "openai",
          model: "fixture",
          reasoningEffort: null,
          timeoutMs: null,
          imageDetail: null,
          prompt: "PRIVATE",
        },
      }).success,
    ).toBe(false);
  });
});
