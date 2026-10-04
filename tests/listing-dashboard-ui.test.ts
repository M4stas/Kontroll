import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { listingSchema } from "../src/listings/contracts";
import { ListingAccessFallback, ListingSections, browserListingJobSchema } from "../src/features/listing/dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
  return browserListingJobSchema.parse(job);
}

describe("listing dashboard UI", () => {
  it("renders all captured listing sections and preserves an HTTP photo URL", () => {
    const job = completedJob();
    const html = renderToStaticMarkup(createElement(ListingSections, {
      locale: "en",
      listing: job.listing,
      waiting: false,
      warnings: job.warnings,
    }));

    for (const text of [
      "Vehicle details",
      "Example",
      "Touring",
      "123456",
      "Synthetic description for UI coverage.",
      "Sample seller",
      "Heated seats",
      "77 kWh",
      "Estonia",
      "Auto24 notes",
    ]) expect(html).toContain(text);
    expect(html).toContain("2022</dd>");
    expect(html).not.toContain("2,022</dd>");
    expect(html).toContain(`href="${sourceUrl}"`);
    expect(html).toContain('src="http://images.example/car.jpg"');
  });

  it("offers check-again recovery for a known job when the service is unavailable", () => {
    const html = renderToStaticMarkup(createElement(ListingAccessFallback, {
      locale: "en",
      jobId: "job-123",
      code: "service_auth_error",
      sourceUrl,
      onCheckAgain: vi.fn(),
    }));

    expect(html).toContain("listing service");
    expect(html).toContain("Check again");
    expect(html).toContain(`href="${sourceUrl}"`);
  });
});


describe('dashboard source recovery', () => {
  it.each(['queued', 'running', 'failed'])('retains the authenticated source URL for a %s job without captured listing data', (status) => {
    const job = browserListingJobSchema.parse({job_id: 'job-123', status, submitted_at: '2026-09-29T08:00:00Z', source_url: sourceUrl, ...(status === 'failed' ? {error: {code: 'parse_failed'}} : {})});
    expect(job.listing).toBeNull();
    expect(job.source_url).toBe(sourceUrl);
  });
});
