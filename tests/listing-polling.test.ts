import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListingJob } from "../src/listings/contracts";
import { createListingPoller, isSlowWait, ListingPollTerminalError } from "../src/features/listing/polling";

function job(status: ListingJob["status"]): ListingJob {
  return {
    job_id: "job-123",
    status,
    submitted_at: new Date(0).toISOString(),
    parsed_at: status === "completed" ? new Date(1).toISOString() : null,
    listing: null,
    error: status === "failed" ? { code: "parse_failed" } : null,
    warnings: [],
  } as ListingJob;
}

function clockHarness() {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    isVisible: () => visible,
    subscribeVisibility: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("listing poller", () => {
  it("checks immediately, polls every second, and stops on completion", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValueOnce(job("running")).mockResolvedValueOnce(job("completed"));
    const onJob = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob,
      onUnavailable: vi.fn(),
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onJob).toHaveBeenCalledWith(job("running"), Date.now());

    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onJob).toHaveBeenLastCalledWith(job("completed"), Date.now());

    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("keeps the last successful check time when a later status request fails", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValueOnce(job("running")).mockRejectedValueOnce(new Error("offline"));
    const onUnavailable = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable,
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    const lastSuccessfulAt = Date.now();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onUnavailable).toHaveBeenCalledWith({ lastSuccessfulAt, retryInMs: 3_000 });
    poller.stop();
  });

  it("caps transient retry delays after repeated failures", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const onUnavailable = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable,
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    expect(onUnavailable).toHaveBeenLastCalledWith({ lastSuccessfulAt: null, retryInMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onUnavailable).toHaveBeenLastCalledWith({ lastSuccessfulAt: null, retryInMs: 6_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onUnavailable).toHaveBeenLastCalledWith({ lastSuccessfulAt: null, retryInMs: 12_000 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onUnavailable).toHaveBeenLastCalledWith({ lastSuccessfulAt: null, retryInMs: 20_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onUnavailable).toHaveBeenLastCalledWith({ lastSuccessfulAt: null, retryInMs: 20_000 });
    poller.stop();
  });

  it("aborts a timed out status request and reports it as a temporary connection failure", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn((_jobId: string, signal: AbortSignal) => new Promise<ListingJob>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const onUnavailable = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable,
      onDeadline: vi.fn(),
      requestTimeoutMs: 12_000,
      clock,
    });

    await vi.advanceTimersByTimeAsync(12_000);
    expect(request).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith({ lastSuccessfulAt: null, retryInMs: 3_000 });
    poller.stop();
  });

  it("stops retrying after an authorization or missing-job response", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockRejectedValue(new ListingPollTerminalError("unauthorized"));
    const onTerminalError = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable: vi.fn(),
      onTerminalError,
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    expect(onTerminalError).toHaveBeenCalledWith("unauthorized");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("stops after the scraper returns a failed job", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValue(job("failed"));
    const onJob = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob,
      onUnavailable: vi.fn(),
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onJob).toHaveBeenCalledWith(job("failed"), Date.now() - 30_000);
    expect(request).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("pauses an in-flight request when hidden and ignores its late result", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    let resolveFirst!: (result: ListingJob) => void;
    const request = vi.fn((_jobId: string, signal: AbortSignal) => {
      if (request.mock.calls.length > 1) return Promise.resolve(job("running"));
      return new Promise<ListingJob>((resolve, reject) => {
        resolveFirst = resolve;
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const onJob = vi.fn();
    const onUnavailable = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob,
      onUnavailable,
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    clock.setVisible(false);
    resolveFirst(job("completed"));
    await flush();
    expect(onJob).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();

    clock.setVisible(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(onJob).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("pauses while hidden and checks the same job as soon as the tab returns", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValue(job("running"));
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable: vi.fn(),
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    clock.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);

    clock.setVisible(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([id]) => id)).toEqual(["job-123", "job-123"]);
    poller.stop();
  });

  it("stops at the polling deadline and can resume the known job", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValue(job("running"));
    const onDeadline = vi.fn();
    const first = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 5_000,
      request,
      onJob: vi.fn(),
      onUnavailable: vi.fn(),
      onDeadline,
      clock,
    });

    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(5);
    first.stop();

    const resumed = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable: vi.fn(),
      onDeadline: vi.fn(),
      clock,
    });
    await flush();
    expect(request.mock.calls.map(([id]) => id)).toEqual(["job-123", "job-123", "job-123", "job-123", "job-123", "job-123"]);
    resumed.stop();
  });

  it("checks a known job once after an expired saved polling window, then pauses if pending", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValue(job("running"));
    const onJob = vi.fn();
    const onDeadline = vi.fn();
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() - 1,
      request,
      onJob,
      onUnavailable: vi.fn(),
      onDeadline,
      clock,
    });

    await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(onJob).toHaveBeenCalledOnce();
    expect(onDeadline).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("does not poll after unmount and recognizes the thirty second slow state", async () => {
    vi.useFakeTimers();
    const clock = clockHarness();
    const request = vi.fn().mockResolvedValue(job("running"));
    const poller = createListingPoller({
      jobId: "job-123",
      deadlineAt: Date.now() + 180_000,
      request,
      onJob: vi.fn(),
      onUnavailable: vi.fn(),
      onDeadline: vi.fn(),
      clock,
    });

    await flush();
    poller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(isSlowWait(1_000, 30_999)).toBe(false);
    expect(isSlowWait(1_000, 31_000)).toBe(true);
  });
});
