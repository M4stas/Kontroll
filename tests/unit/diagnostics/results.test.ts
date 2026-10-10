import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DiagnosticsRepository } from "@/server/repositories/diagnostics";
it("sanitizes saved findings and action tokens", async () => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      error: null,
      data: {
        result_hash: "hash",
        completed_at: "2026-10-09T12:00:00Z",
        result: {
          schemaVersion: 1,
          warnings: [],
          observations: [
            {
              id: "finding",
              evidenceIds: ["image"],
              category: "condition",
              title: "Inspect api_key=sentinel",
              severity: "important",
              explanation: "See https://example.com/photo?token=secret",
              recommendedAction: {
                kind: "inspection_task",
                title: "Check access_token=action-secret",
                instructions: "Use Bearer action-token",
              },
              confidence: 0.9,
            },
          ],
        },
      },
    }),
  };
  const repository = new DiagnosticsRepository({ from: vi.fn().mockReturnValue(query) } as unknown as SupabaseClient);
  vi.spyOn(repository, "load").mockResolvedValue({
    owner: { analysisId: "analysis" },
    reviews: [{ executionId: "execution", resultAvailable: true, state: "complete", reusedFrom: null }],
  } as never);
  const result = await repository.result("public", "run", "execution");
  expect(JSON.stringify(result)).not.toMatch(/sentinel|action-secret|action-token|token=secret/);
  expect(result?.result?.observations[0]!.title).toBe("Inspect api_key=[redacted]");
  expect(result?.result?.observations[0]!.explanation).toBe("See https://example.com/photo");
});
