import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Auto24ListingAdapter, parseAuto24Html } from "@/listings/auto24";

const listingUrl = new URL("https://www.auto24.ee/soidukid/123456");
const fixture = readFileSync("tests/fixtures/auto24-listing.html", "utf8");

describe("parseAuto24Html", () => {
  // Catches a parser regression that lets lower-priority data replace semantic listing facts,
  // drops JSON-LD identity or labeled specifications, or upgrades seller/listing claims.
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
        sourceClass: "listing",
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
});
