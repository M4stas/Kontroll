export class ListingSubmissionTimeoutError extends Error {
  constructor() {
    super("Listing submission timed out");
    this.name = "ListingSubmissionTimeoutError";
  }
}

export class ListingSubmissionInProgressError extends Error {
  constructor() {
    super("A listing submission is already in progress");
    this.name = "ListingSubmissionInProgressError";
  }
}

export interface ListingSubmissionResult {
  response: Response;
  body: unknown;
}

export function createListingSubmitter(
  request: typeof fetch = fetch,
  timeoutMs = 12_000,
) {
  let pending = false;

  return async function submitListing(listingUrl: string): Promise<ListingSubmissionResult> {
    if (pending) throw new ListingSubmissionInProgressError();
    pending = true;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ListingSubmissionTimeoutError());
        controller.abort();
      }, timeoutMs);
    });
    const responseBody = (async () => {
      const response = await request("/api/listings", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ listingUrl }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      return { response, body };
    })();

    try {
      return await Promise.race([responseBody, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      pending = false;
    }
  };
}
