import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Auto24ListingAdapter, parseAuto24Html } from "@/listings/auto24";

const listingUrl = new URL("https://www.auto24.ee/soidukid/123456");
const fixture = readFileSync("tests/fixtures/auto24-listing.html", "utf8");

describe("parseAuto24Html", () => {
  it("classifies only explicitly labeled inspection images", () => {
    const result = parseAuto24Html(`<img data-testid="listing-image" src="/a.jpg" alt="Underside"/><img data-testid="listing-image" src="/b.jpg" alt="Engine bay"/><img data-testid="listing-image" src="/c.jpg" alt="Instrument cluster"/><img data-testid="listing-image" src="/d.jpg" alt="Service document"/><img data-testid="listing-image" src="/e.jpg"/>`, listingUrl);
    expect(result.inspectionImages).toEqual([
      { url: "/a.jpg", category: "underside" },
      { url: "/b.jpg", category: "engine_bay" },
      { url: "/c.jpg", category: "instrument_cluster" },
      { url: "/d.jpg", category: "service_document" },
    ]);
  });
  // Catches a parser regression that lets lower-priority data replace semantic listing facts,
  // drops JSON-LD identity or labeled specifications, or loses unverified seller provenance.
  it("extracts normalized unverified facts from semantic HTML, JSON-LD, and labeled rows", () => {
    const result = parseAuto24Html(fixture, listingUrl);

    expect(result).toMatchObject({
      type: "snapshot",
      marketplace: "auto24",
      sourceUrl: "https://www.auto24.ee/soidukid/123456",
      contentHash: "aa39790ee0e57e085d64cca04089c11870ae2cbfe619d3d22f5cb2bfce299a4f",
      description: "Müüja sõnul on auto regulaarselt hooldatud ja avariivaba.",
      imageUrls: [
        "https://images.auto24.ee/avensis-front.jpg",
        "https://images.auto24.ee/avensis-interior.jpg",
      ],
    });
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "title", value: "Toyota Avensis 2.0 D-4D", verification: "unverified" }),
        expect.objectContaining({ key: "price", value: "12 800 €", verification: "unverified" }),
        expect.objectContaining({ key: "make", value: "Toyota", verification: "unverified" }),
        expect.objectContaining({ key: "model", value: "Avensis", verification: "unverified" }),
        expect.objectContaining({ key: "year", value: "2017", verification: "unverified" }),
        expect.objectContaining({ key: "mileage", value: "182 000 km", verification: "unverified" }),
        expect.objectContaining({ key: "fuel", value: "Diisel", verification: "unverified" }),
        expect.objectContaining({ key: "gearbox", value: "Manuaal", verification: "unverified" }),
      ]),
    );
    expect(result.claims).toContainEqual(
      expect.objectContaining({
        text: "Müüja sõnul on auto regulaarselt hooldatud ja avariivaba.",
        sourceClass: "seller",
        verification: "unverified",
      }),
    );
  });
});

describe("Auto24ListingAdapter.capture", () => {
  // Catches accidental live access while direct Auto24 fetching is disabled.
  it("requires fallback when fetching is disabled", async () => {
    const adapter = new Auto24ListingAdapter({ fetchEnabled: false });

    await expect(adapter.capture({ url: listingUrl })).resolves.toEqual({
      type: "fallback_required",
      reason: "fetch_disabled",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
  });

  // Catches a host validation regression that attempts to retrieve an unsupported marketplace.
  it("requires fallback for unsupported listing URLs", async () => {
    const adapter = new Auto24ListingAdapter({ fetchEnabled: true });

    await expect(adapter.capture({ url: new URL("https://example.com/car/1") })).resolves.toEqual({
      type: "fallback_required",
      reason: "unsupported_url",
      listingUrl: "https://example.com/car/1",
    });
  });

  // Catches unsafe or noncanonical Auto24 URLs reaching the external fetch boundary.
  it.each([
    "http://www.auto24.ee/soidukid/123456",
    "ftp://www.auto24.ee/soidukid/123456",
    "https://www.auto24.ee:444/soidukid/123456",
    "https://buyer:secret@www.auto24.ee/soidukid/123456",
    "https://seller.auto24.ee/soidukid/123456",
  ])("rejects unsafe or noncanonical Auto24 URL %s", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(fixture, { status: 200 }),
    );
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: new URL(value) })).resolves.toMatchObject({
      type: "fallback_required",
      reason: "unsupported_url",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // Catches treating access-denied and CAPTCHA-style pages as listings instead of asking the buyer for input.
  it("requires fallback for a blocked response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("Access denied", { status: 403 }),
    );
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toEqual({
      type: "fallback_required",
      reason: "blocked_response",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
  });

  // Catches unread blocked or failed response bodies being left open on pre-read exits.
  it.each([
    [403, "blocked_response"],
    [500, "fetch_failed"],
  ] as const)("cancels the unread response body for HTTP %i", async (status, reason) => {
    const response = new Response("unread response", { status });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toMatchObject({
      type: "fallback_required",
      reason,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // Catches null bodies turning a typed blocked-response fallback into a runtime error.
  it("returns typed fallback when the unread response body is null", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 403 }),
    );
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toMatchObject({
      type: "fallback_required",
      reason: "blocked_response",
    });
  });

  // Catches a failed body cancellation replacing the adapter's typed fallback with a throw.
  it("returns typed fallback when response body cancellation rejects", async () => {
    const response = new Response("unread response", { status: 403 });
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockRejectedValue(new Error("cancel failed"));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toMatchObject({
      type: "fallback_required",
      reason: "blocked_response",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // Catches a response-body failure escaping as a generic error instead of preserving the fallback path.
  it("requires fallback when a fetched response body cannot be read", async () => {
    const response = new Response(fixture, { status: 200 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("body read failed"));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toEqual({
      type: "fallback_required",
      reason: "fetch_failed",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
  });

  // Catches accepting malformed HTML that cannot identify both the vehicle make and model.
  it("requires fallback when malformed HTML has no required identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("<main><h1>Featured vehicle", { status: 200 }),
    );
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    await expect(adapter.capture({ url: listingUrl })).resolves.toEqual({
      type: "fallback_required",
      reason: "missing_required_identity",
      listingUrl: "https://www.auto24.ee/soidukid/123456",
    });
  });

  // Catches a policy regression that omits the finite, anonymous Auto24 request boundary.
  it("captures a supported listing with a bounded anonymous request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(fixture, { status: 200 }),
    );
    const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });

    const result = await adapter.capture({ url: listingUrl });

    expect(result).toMatchObject({ type: "snapshot", marketplace: "auto24" });
    expect(fetch).toHaveBeenCalledWith(
      listingUrl,
      expect.objectContaining({
        credentials: "omit",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Kontroll used-car analysis prototype listing capture",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  // Catches the request aborting before or after the required 15-second deadline.
  it("returns fallback exactly when the 15-second request timeout expires", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
        return controller.signal;
      });
      const fetch = vi.fn<typeof globalThis.fetch>((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected a request abort signal");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      );
      const adapter = new Auto24ListingAdapter({ fetch, fetchEnabled: true });
      const capture = adapter.capture({ url: listingUrl });
      let result: Awaited<typeof capture> | undefined;
      void capture.then((value) => {
        result = value;
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(result).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({
        type: "fallback_required",
        reason: "fetch_failed",
        listingUrl: "https://www.auto24.ee/soidukid/123456",
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
