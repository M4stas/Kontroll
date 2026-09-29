import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createListingSubmitter,
  ListingSubmissionInProgressError,
  ListingSubmissionTimeoutError,
} from "../src/features/listing/submission";

afterEach(() => vi.useRealTimers());

describe("listing submission", () => {
  it("aborts a request that stays unresolved past its timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const submit = createListingSubmitter((_input, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }, 12_000);
    const pending = submit("https://www.auto24.ee/soidukid/123");
    const timedOut = expect(pending).rejects.toBeInstanceOf(ListingSubmissionTimeoutError);

    await vi.advanceTimersByTimeAsync(12_000);
    await timedOut;
    expect(signal?.aborted).toBe(true);
  });

  it("rejects a concurrent duplicate without making a second POST", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    const submit = createListingSubmitter(request);
    const first = submit("https://www.auto24.ee/soidukid/123");

    await expect(submit("https://www.auto24.ee/soidukid/123")).rejects.toBeInstanceOf(ListingSubmissionInProgressError);
    expect(request).toHaveBeenCalledOnce();

    resolveRequest(new Response(JSON.stringify({ jobId: "job-123" }), { status: 202 }));
    await expect(first).resolves.toMatchObject({ body: { jobId: "job-123" }, response: { status: 202 } });
  });
});
