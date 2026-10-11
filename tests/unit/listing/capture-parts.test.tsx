import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { listingSchema } from "../../../src/listings/contracts";
import { CaptureProgress } from "../../../src/features/listing/capture-progress";
import { CapturePhotos } from "../../../src/features/listing/capture-photos";
import { CaptureFacts } from "../../../src/features/listing/capture-facts";
import { listingText } from "../../../src/features/listing/messages";

const sourceUrl = "https://www.auto24.ee/soidukid/123456";

function completedJob() {
  const listing = listingSchema.parse({
    source_url: sourceUrl,
    listing_id: "123456",
    title: "Electric estate",
    make: "Example",
    model: "Touring",
    year: 2022,
    year_source: "first_registration",
    first_registration: "2022-03",
    price: { amount: 41_500, currency: "EUR" },
    mileage_km: 46_800,
    fuel: "electric",
    power_kw: 195,
    gearbox: "automatic",
    drivetrain: "all-wheel drive",
    body_type: "estate",
    colour: "black",
    seller_description: "Synthetic description for UI coverage.",
    seller: { name: "Sample seller", type: "company", location: "Tallinn" },
    equipment: { Comfort: ["Heated seats"] },
    technical_specs: { "Battery capacity": "77 kWh" },
    other_fields: { Registration: "Estonia" },
    photo_urls: ["https://images.example/car.jpg"],
  });
  const job = {
    job_id: "job-123",
    status: "completed",
    submitted_at: "2026-09-29T08:00:00.000Z",
    parsed_at: "2026-09-29T08:00:12.000Z",
    listing: { ...listing, photo_urls: ["http://images.example/car.jpg"] },
    error: null,
    warnings: ["A seller field was not available."],
  };
  return job;
}


describe("capture progress", () => {
  it.each([
    [null, ["active", "waiting", "waiting"]],
    ["queued", ["active", "waiting", "waiting"]],
    ["running", ["done", "active", "waiting"]],
    ["completed", ["done", "done", "done"]],
    ["failed", ["done", "failed", "waiting"]],
  ] as const)("shows steps for %s", (status, states) => {
    const html = renderToStaticMarkup(<CaptureProgress locale="en" status={status}>Live status</CaptureProgress>);
    const items = [...html.matchAll(/<li([^>]*)>(.*?)<\/li>/g)];
    expect(items).toHaveLength(3);
    items.forEach((item, index) => {
      expect(item[1]).toContain(`data-state="${states[index]}"`);
      expect(item[1]?.includes('aria-current="step"')).toBe(states[index] === "active" || states[index] === "failed");
    });
    expect(html).toContain(`data-state="${status ?? "running"}"`);
    for (const text of ["Request received", "Reading the listing", "Details ready", "Live status"]) expect(html).toContain(text);
  });
  it("allows a connection notice state on the section", () => {
    const html = renderToStaticMarkup(<CaptureProgress locale="en" status="running" data-state="connection">Retrying</CaptureProgress>);
    expect(html).toMatch(/<section[^>]*data-state="connection"/);
    expect(html).toContain('data-state="active"');
  });
});

describe("capture photos", () => {
  it("shows eight hidden placeholders while waiting", () => {
    const html = renderToStaticMarkup(createElement(CapturePhotos, { locale: "en", photoUrls: null, waiting: true }));
    expect(html.match(/class="photo-tile is-loading" aria-hidden="true"/g)).toHaveLength(8);
    expect(html).toContain(listingText("en", "unavailableForNow"));
  });
  it("keeps HTTP and HTTPS images and drops unsafe URLs", () => {
    const html = renderToStaticMarkup(createElement(CapturePhotos, { locale: "en", photoUrls: ["http://images.example/car.jpg", "https://images.example/two.jpg", "javascript:alert(1)", "data:image/png;base64,a", "//images.example/three.jpg", "file:///car.jpg"], waiting: false }));
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="http://images.example/car.jpg"');
    expect(html).toContain('src="http://images.example/car.jpg"');
    expect(html).toContain('alt="Auto24 listing photo 1"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('target="_blank" rel="noreferrer"');
    for (const text of ["javascript:", "data:image", "three.jpg", "file:"]) expect(html).not.toContain(text);
  });
  it("shows the empty message when no safe photos remain", () => {
    for (const photoUrls of [[], ["javascript:alert(1)"]]) {
      expect(renderToStaticMarkup(createElement(CapturePhotos, { locale: "en", photoUrls, waiting: false }))).toContain(listingText("en", "noPhotos"));
    }
  });
  it("renders nothing without a listing when not waiting", () => {
    expect(renderToStaticMarkup(createElement(CapturePhotos, { locale: "en", photoUrls: null, waiting: false }))).toBe("");
  });
});

describe("capture facts", () => {
  it("renders all 13 facts with a plain year and report actions", () => {
    const html = renderToStaticMarkup(<CaptureFacts locale="en" listing={completedJob().listing} waiting={false}><button>Open report</button></CaptureFacts>);
    expect(html.match(/<dt>/g)).toHaveLength(13);
    for (const key of ["make", "model", "year", "firstRegistration", "listingPrice", "mileage", "fuel", "power", "gearbox", "drivetrain", "bodyType", "colour", "listingId"] as const) expect(html).toContain(listingText("en", key));
    for (const value of ["Example", "Touring", "2022", "41,500 EUR", "46,800 km"]) expect(html).toContain(`>${value}</dd>`);
    expect(html).not.toContain("2,022");
    expect(html).toContain("Open report");
  });
  it("shows accessible placeholders for all facts while waiting", () => {
    const html = renderToStaticMarkup(<CaptureFacts locale="et" listing={null} waiting>Actions</CaptureFacts>);
    expect(html.match(/class="fact-placeholder"/g)).toHaveLength(13);
    expect(html).toContain(listingText("et", "unavailableForNow"));
    expect(html).toContain("Actions");
  });
  it("shows unavailable values without placeholders when no longer waiting", () => {
    const html = renderToStaticMarkup(<CaptureFacts locale="en" listing={null} waiting={false}>{null}</CaptureFacts>);
    expect(html.match(/<dt>/g)).toHaveLength(13);
    expect(html).not.toContain("fact-placeholder");
    expect(html).toContain(listingText("en", "unavailable"));
  });
});
