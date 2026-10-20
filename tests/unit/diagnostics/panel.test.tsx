import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import messages from "../../../messages/en.json";
import { DiagnosticsPanel } from "@/features/diagnostics/diagnostics-panel";
import type { DiagnosticReview, DiagnosticsSnapshot } from "@/diagnostics/contracts";
const state = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("@/features/diagnostics/use-diagnostics", () => ({
  useDiagnostics: () => ({ snapshot: state.snapshot, connection: "loading", lastRefresh: null, retry: vi.fn() }),
}));
beforeEach(() => {
  state.snapshot = null;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);
const photo: DiagnosticReview = {
  key: "image", executionId: "execution", pass: "image", evidenceId: "image /1", selected: true, state: "running",
  settings: null, attempts: [], latestAttempt: null, durationMs: null, resultAvailable: false, completedAt: null, reusedFrom: null,
};
function snapshot(capture: DiagnosticsSnapshot["capture"]): DiagnosticsSnapshot {
  return {
    version: 1, serverNow: "2026-10-09T12:00:00Z", owner: { publicId: "owner", analysisId: "analysis" },
    currentRunId: "run", runId: "run", runs: [], stages: [], reviews: [photo], spans: [],
    availability: { review: "available", internalTimings: "not_recorded" }, nextCursor: null, truncated: false, capture,
  } as DiagnosticsSnapshot;
}
function open() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DiagnosticsPanel publicId="owner" enabled />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Live diagnostics" }));
}
it("hides the entry when disabled and opens an accessible dialog when enabled", () => {
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DiagnosticsPanel publicId="owner" enabled={false} />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByRole("button", { name: "Live diagnostics" })).toBeNull();
  view.rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DiagnosticsPanel publicId="owner" enabled />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Live diagnostics" }));
  expect(screen.getByRole("dialog", { name: "Live diagnostics" })).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("report drawer shows capture timings above photo reviews", () => {
  state.snapshot = snapshot({
    availability: "available", omitted: 0,
    spans: [{ id: "q", attempt: 1, phase: "queue_wait", state: "complete", startedAt: "2026-10-09T11:59:00Z", completedAt: "2026-10-09T11:59:02Z", durationMs: 2000, errorCode: null }],
  });
  open();
  const capture = screen.getByRole("heading", { name: "Listing capture timings" });
  const firstPhoto = screen.getByText("Photo preparation timings");
  expect(capture.compareDocumentPosition(firstPhoto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(/Queue wait/).closest("li")?.textContent).toBe("Queue wait · 2.0 s · Complete");
});
it("report drawer says capture not applicable for pasted text", () => {
  state.snapshot = snapshot({ availability: "not_applicable", spans: [], omitted: 0 });
  open();
  expect(screen.getByText("Not applicable. This report was made from pasted text.")).toBeTruthy();
});
