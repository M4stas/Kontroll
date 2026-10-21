import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";
import { ListingDiagnosticsPanel } from "@/features/diagnostics/listing-diagnostics-panel";
import { afterEach, expect, it, vi } from "vitest";
import { useDiagnostics } from "@/features/diagnostics/use-diagnostics";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("polls only while open and discovers a new run after completion", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      version: 1,
      serverNow: "2026-10-09T12:00:00Z",
      owner: { publicId: "owner", analysisId: "analysis" },
      currentRunId: "new",
      runId: "new",
      runs: [],
      stages: [],
      reviews: [],
      spans: [],
      availability: { review: "available", internalTimings: "not_recorded" },
      nextCursor: null,
      truncated: false,
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useDiagnostics("owner", open), {
    initialProps: { open: false },
  });
  expect(fetcher).not.toHaveBeenCalled();
  rerender({ open: true });
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(result.current.snapshot?.runId).toBe("new");
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender({ open: false });
  await act(async () => {
    vi.advanceTimersByTime(9000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("backs off failures to 6, 12, and 30 seconds and can retry immediately", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useDiagnostics("owner", true));
  await act(async () => {});
  for (const delay of [6000, 12000, 30000]) {
    const count = fetcher.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(delay - 1);
    });
    expect(fetcher).toHaveBeenCalledTimes(count);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
  }
  await act(async () => {
    result.current.retry();
  });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("loads older attempt pages without changing the selected current run", async () => {
  vi.useFakeTimers();
  const data = {
    version: 1,
    serverNow: "2026-10-09T12:00:00Z",
    owner: { publicId: "owner", analysisId: "analysis" },
    currentRunId: "current",
    runId: "current",
    runs: [],
    stages: [],
    reviews: [],
    spans: [],
    availability: { review: "available", internalTimings: "not_recorded" },
    nextCursor: "200",
    truncated: true,
  };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useDiagnostics("owner", true));
  await act(async () => {});
  await act(async () => {
    result.current.loadOlder();
  });
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("cursor=200");
  expect(result.current.snapshot?.runId).toBe("current");
  await act(async () => {
    result.current.showRecent();
  });
  expect(fetcher.mock.calls.at(-1)?.[0]).not.toContain("cursor=");
});

it("ignores a late response after the owner changes and permits only one in-flight request", async () => {
  vi.useFakeTimers();
  let resolveOld!: (value: unknown) => void;
  const snapshot = (owner: string) => ({
    version: 1,
    serverNow: "2026-10-09T12:00:00Z",
    owner: { publicId: owner, analysisId: owner },
    currentRunId: "current",
    runId: "current",
    runs: [],
    stages: [],
    reviews: [],
    spans: [],
    availability: { review: "available", internalTimings: "not_recorded" },
    nextCursor: null,
    truncated: false,
  });
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, json: async () => snapshot("next") });
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ owner }) => useDiagnostics(owner, true), {
    initialProps: { owner: "old" },
  });
  await act(async () => {
    vi.advanceTimersByTime(12000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  rerender({ owner: "next" });
  await act(async () => {});
  expect(signal.aborted).toBe(true);
  expect(result.current.snapshot?.owner.publicId).toBe("next");
  await act(async () => {
    resolveOld({ ok: true, json: async () => snapshot("old") });
  });
  expect(result.current.snapshot?.owner.publicId).toBe("next");
});

it("pauses hidden polling and refreshes immediately when visible again", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  renderHook(() => useDiagnostics("owner", true));
  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(fetcher).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(30000);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  visibility.mockRestore();
});

it("listing panel polls /api/listings/{jobId}/diagnostics every 3 s only while open and visible", async () => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      version: 1,
      serverNow: "2026-10-13T12:00:00Z",
      jobId: "job-1",
      status: "running",
      capture: { availability: "available", spans: [], omitted: 0 },
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ListingDiagnosticsPanel jobId="job-1" enabled />
    </NextIntlClientProvider>,
  );
  await act(async () => {
    vi.advanceTimersByTime(9000);
  });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Live diagnostics" }));
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe("/api/listings/job-1/diagnostics");
  expect(screen.getByText("Capture status: Running")).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  visibility = "hidden";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(9000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  visibility = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
  });
  await act(async () => {
    vi.advanceTimersByTime(9000);
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
