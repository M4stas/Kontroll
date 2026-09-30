import type { ListingJob } from "../../listings/contracts";

export const POLL_INTERVAL_MS = 1_000;
export const POLL_TIMEOUT_MS = 12_000;
export const POLL_WINDOW_MS = 180_000;
export const SLOW_WAIT_MS = 30_000;

const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 20_000] as const;

export type ListingPollTerminalCode =
  | "unauthorized"
  | "forbidden"
  | "job_not_found"
  | "configuration_error"
  | "service_auth_error"
  | "invalid_service_response";

export class ListingPollTerminalError extends Error {
  constructor(readonly code: ListingPollTerminalCode) {
    super(code);
    this.name = "ListingPollTerminalError";
  }
}

export interface ListingPollClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  isVisible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
}

export interface ListingPollerOptions {
  jobId: string;
  deadlineAt: number;
  request(jobId: string, signal: AbortSignal): Promise<ListingJob>;
  onJob(job: ListingJob, checkedAt: number): void;
  onUnavailable(result: { lastSuccessfulAt: number | null; retryInMs: number }): void;
  onTerminalError?(code: ListingPollTerminalCode): void;
  onDeadline(): void;
  requestTimeoutMs?: number;
  clock?: ListingPollClock;
}

function browserClock(): ListingPollClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: (timer) => window.clearTimeout(timer as unknown as number),
    isVisible: () => !document.hidden,
    subscribeVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export function isSlowWait(submittedAt: number, now: number): boolean {
  return now - submittedAt >= SLOW_WAIT_MS;
}

export function createListingPoller({
  jobId,
  deadlineAt,
  request,
  onJob,
  onUnavailable,
  onTerminalError,
  onDeadline,
  requestTimeoutMs = POLL_TIMEOUT_MS,
  clock = browserClock(),
}: ListingPollerOptions) {
  let active = true;
  let attempt = 0;
  let failureCount = 0;
  let postDeadlineCheckPending = clock.now() >= deadlineAt;
  let lastSuccessfulAt: number | null = null;
  let nextPollTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let removeVisibilityListener = () => {};

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer !== null) clock.clearTimeout(timer);
    return null;
  }

  function stop() {
    if (!active) return;
    active = false;
    nextPollTimer = clearTimer(nextPollTimer);
    deadlineTimer = clearTimer(deadlineTimer);
    requestTimer = clearTimer(requestTimer);
    controller?.abort();
    controller = null;
    removeVisibilityListener();
  }

  function pauseForDeadline() {
    if (!active) return;
    stop();
    onDeadline();
  }

  function scheduleNext(delay: number) {
    if (!active || !clock.isVisible()) return;
    const remaining = deadlineAt - clock.now();
    if (remaining <= 0) {
      pauseForDeadline();
      return;
    }
    nextPollTimer = clearTimer(nextPollTimer);
    nextPollTimer = clock.setTimeout(() => {
      nextPollTimer = null;
      void poll();
    }, Math.min(delay, remaining));
  }

  async function poll() {
    if (!active || !clock.isVisible()) return;
    if (clock.now() >= deadlineAt && !postDeadlineCheckPending) {
      pauseForDeadline();
      return;
    }

    const isPostDeadlineCheck = postDeadlineCheckPending;
    postDeadlineCheckPending = false;
    const currentAttempt = ++attempt;
    const currentController = new AbortController();
    controller = currentController;
    let rejectAborted!: (reason: DOMException) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const handleAbort = () => rejectAborted(new DOMException("Status request aborted", "AbortError"));
    currentController.signal.addEventListener("abort", handleAbort, { once: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = clock.setTimeout(() => {
        currentController.abort();
        reject(new DOMException("Status request timed out", "TimeoutError"));
      }, requestTimeoutMs);
      requestTimer = timer;
    });
    const currentRequestTimer = requestTimer;

    try {
      const job = await Promise.race([request(jobId, currentController.signal), aborted, timeout]);
      if (!active || currentAttempt !== attempt) return;
      lastSuccessfulAt = clock.now();
      failureCount = 0;
      onJob(job, lastSuccessfulAt);
      if (job.status === "completed" || job.status === "failed") {
        stop();
        return;
      }
      if (isPostDeadlineCheck || clock.now() >= deadlineAt) {
        pauseForDeadline();
        return;
      }
      scheduleNext(POLL_INTERVAL_MS);
    } catch (error) {
      if (!active || currentAttempt !== attempt || !clock.isVisible()) return;
      if (error instanceof ListingPollTerminalError) {
        stop();
        onTerminalError?.(error.code);
        return;
      }
      failureCount += 1;
      const retryInMs = RETRY_DELAYS_MS[Math.min(failureCount - 1, RETRY_DELAYS_MS.length - 1)]
        ?? 20_000;
      onUnavailable({ lastSuccessfulAt, retryInMs });
      if (isPostDeadlineCheck || clock.now() >= deadlineAt) {
        pauseForDeadline();
        return;
      }
      scheduleNext(retryInMs);
    } finally {
      if (currentRequestTimer !== null) {
        clock.clearTimeout(currentRequestTimer);
        if (requestTimer === currentRequestTimer) requestTimer = null;
      }
      currentController.signal.removeEventListener("abort", handleAbort);
      if (currentAttempt === attempt) {
        controller = null;
      }
    }
  }

  function handleVisibility() {
    if (!active) return;
    if (!clock.isVisible()) {
      nextPollTimer = clearTimer(nextPollTimer);
      attempt += 1;
      requestTimer = clearTimer(requestTimer);
      controller?.abort();
      controller = null;
      return;
    }
    if (clock.now() >= deadlineAt && !postDeadlineCheckPending) {
      pauseForDeadline();
      return;
    }
    nextPollTimer = clearTimer(nextPollTimer);
    void poll();
  }

  removeVisibilityListener = clock.subscribeVisibility(handleVisibility);
  if (!postDeadlineCheckPending) {
    deadlineTimer = clock.setTimeout(pauseForDeadline, Math.max(0, deadlineAt - clock.now()));
  }
  void poll();

  return { stop };
}
