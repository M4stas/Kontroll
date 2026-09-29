import { afterEach, expect, it, vi } from "vitest";
import type { ListingJob } from "../src/listings/contracts";
import { createListingPoller } from "../src/features/listing/polling";

afterEach(() => vi.useRealTimers());

it("keeps the resumed request timeout when the hidden request settles late", async () => {
  vi.useFakeTimers();
  let visible = true;
  const listeners = new Set<() => void>();
  const clock = {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    isVisible: () => visible,
    subscribeVisibility(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
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

  await Promise.resolve();
  clock.setVisible(false);
  clock.setVisible(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(12_000);
  expect(onUnavailable).toHaveBeenCalledWith({ lastSuccessfulAt: null, retryInMs: 3_000 });
  poller.stop();
});
