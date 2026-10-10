import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import messages from "../../../messages/en.json";
import { ReviewCard } from "@/features/diagnostics/review-card";
import type { DiagnosticReview, DiagnosticsResult } from "@/diagnostics/contracts";
const review: DiagnosticReview = {
  key: "image",
  executionId: "execution",
  pass: "image",
  evidenceId: "image /1",
  selected: true,
  state: "reused",
  settings: null,
  attempts: [],
  latestAttempt: null,
  durationMs: null,
  resultAvailable: true,
  completedAt: null,
  reusedFrom: { runId: "old", executionId: "old-execution", completedAt: null },
};
function show(observations: unknown[] = [], cache = new Map<string, DiagnosticsResult>()) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        executionId: "execution",
        runId: "run",
        state: "reused",
        reusedFrom: review.reusedFrom,
        result: { schemaVersion: 1, observations, warnings: [] },
      }),
    }),
  );
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReviewCard
        review={review}
        publicId="public"
        runId="run"
        number={1}
        serverNow="2026-10-09T12:00:00Z"
        provisional
        cache={cache}
      />
    </NextIntlClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("lazily loads authenticated image, zero results, reuse and provisional status", async () => {
  show();
  expect(screen.queryByRole("img")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByText(/Reused from run old/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show saved findings" }));
  expect(await screen.findByText("No observations recorded.")).toBeInTheDocument();
  expect(screen.getByText(/Provisional findings/)).toBeInTheDocument();
  expect(
    new URL(screen.getByRole("img", { name: "Photo 1" }).getAttribute("src")!, window.location.origin).pathname,
  ).toBe("/api/analyses/public/images/image%20%2F1");
  expect(screen.getByRole("img")).toHaveAttribute("loading", "lazy");
});
it("renders saved findings and instructions", async () => {
  show([
    {
      id: "finding",
      evidenceIds: ["image"],
      category: "condition",
      title: "Panel scratch",
      severity: "important",
      explanation: "Visible mark",
      recommendedAction: { kind: "inspection_task", title: "Inspect", instructions: "Check the panel" },
      confidence: 0.8,
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Show saved findings" }));
  expect(await screen.findByText("Panel scratch")).toBeInTheDocument();
  expect(screen.getByText("Check the panel")).toBeInTheDocument();
});

it.each(["fetch", "cache"])("clears a failed load after reopening with a successful %s result", async (source) => {
  const cache = new Map<string, DiagnosticsResult>();
  show([], cache);
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Show saved findings" }));
  expect(await screen.findByText("Saved findings could not be loaded.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide saved findings" }));
  if (source === "cache") {
    cache.set("public:run:execution", {
      executionId: "execution",
      runId: "run",
      state: "reused",
      reusedFrom: review.reusedFrom,
      result: { schemaVersion: 1, observations: [], warnings: [] },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "Show saved findings" }));
  expect(await screen.findByText("No observations recorded.")).toBeInTheDocument();
  expect(screen.queryByText("Saved findings could not be loaded.")).not.toBeInTheDocument();
});
