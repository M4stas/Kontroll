import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it } from "vitest";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import { CaptureTimings } from "@/features/diagnostics/capture-timings";
import type { CaptureSpan, CaptureTimings as Data } from "@/diagnostics/contracts";

afterEach(cleanup);

const span = (id: string, attempt: number, phase: CaptureSpan["phase"], overrides: Partial<CaptureSpan> = {}): CaptureSpan => ({
  id, attempt, phase, state: "complete", startedAt: "2026-10-13T12:00:00Z", completedAt: "2026-10-13T12:00:01Z",
  durationMs: 1000, errorCode: null, ...overrides,
});
const capture = (spans: CaptureSpan[], overrides: Partial<Data> = {}): Data => ({ availability: "available", spans, omitted: 0, ...overrides });
const serverNow = "2026-10-13T12:00:05Z";
function show(data: Data, locale: "en" | "et" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : et}>
      <CaptureTimings capture={data} serverNow={serverNow} />
    </NextIntlClientProvider>,
  );
}

it("renders phases in fixed order grouped by attempt", () => {
  const { container } = show(capture([
    span("p2", 2, "parsing"), span("n1", 1, "navigation"), span("b1", 1, "browser_start"),
    span("q2", 2, "queue_wait"), span("r1", 1, "retry_wait"), span("q1", 1, "queue_wait"),
    span("s1", 1, "browser_shutdown"), span("h1", 1, "html_retrieval"),
  ]));
  const attempts = [...container.querySelectorAll("[data-attempt]")];
  expect(attempts.map((node) => node.getAttribute("data-attempt"))).toEqual(["1", "2"]);
  expect([...attempts[0]!.querySelectorAll("[data-phase]")].map((node) => node.getAttribute("data-phase"))).toEqual([
    "queue_wait", "retry_wait", "browser_start", "navigation", "html_retrieval", "browser_shutdown",
  ]);
  expect(within(attempts[0] as HTMLElement).getByText("Attempt 1")).toBeTruthy();
  expect([...attempts[1]!.querySelectorAll("[data-phase]")].map((node) => node.getAttribute("data-phase"))).toEqual(["queue_wait", "parsing"]);
});

it("labels queue and retry waits separately from work", () => {
  const { container } = show(capture([span("q1", 1, "queue_wait"), span("r1", 1, "retry_wait"), span("b1", 1, "browser_start")]));
  const lists = [...container.querySelectorAll("[data-attempt] ul")];
  expect(lists).toHaveLength(2);
  expect(lists[0]!.previousElementSibling?.textContent).toBe("Waiting");
  expect(lists[0]!.textContent).toContain("Queue wait");
  expect(lists[0]!.textContent).toContain("Retry wait");
  expect(lists[1]!.previousElementSibling?.textContent).toBe("Capture work");
  expect(lists[1]!.textContent).toContain("Browser start");
  expect(lists[1]!.textContent).not.toContain("wait");
});

it("running phase shows elapsed time from serverNow", () => {
  show(capture([span("n1", 1, "navigation", { state: "running", startedAt: "2026-10-13T12:00:02Z", completedAt: null, durationMs: null })]));
  expect(screen.getByText(/Page load/).closest("li")?.textContent).toBe("Page load · 3.0 s · Running");
});

it("failed phase shows failed state", () => {
  show(capture([span("v1", 1, "validation", { state: "failed", durationMs: 12, errorCode: "phase_failed" })]));
  expect(screen.getByText(/Page checks/).closest("li")?.textContent).toBe("Page checks · 12 ms · Failed · Phase failed");
});

it.each([
  ["unavailable", "Capture timings could not be loaded."],
  ["not_recorded", "Not recorded"],
  ["not_applicable", "Not applicable. This report was made from pasted text."],
  ["disabled", "Capture timings are off in the extraction service."],
] as const)("availability %s renders its own text", (availability, text) => {
  show(capture([], { availability }));
  expect(screen.getByText(text)).toBeTruthy();
});

it("shows the omitted count", () => {
  show(capture([span("b1", 1, "browser_start")], { omitted: 3 }));
  expect(screen.getByText("3 timing updates were not saved, so some phases may be missing.")).toBeTruthy();
});

it("renders in Estonian", () => {
  show(capture([span("q1", 1, "queue_wait"), span("n1", 1, "navigation")]), "et");
  expect(screen.getByText("Kuulutuse lugemise ajad")).toBeTruthy();
  expect(screen.getByText(/Järjekorra ootus/)).toBeTruthy();
  expect(screen.getByText(/Lehe laadimine/)).toBeTruthy();
});
