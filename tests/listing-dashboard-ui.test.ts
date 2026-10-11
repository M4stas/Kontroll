import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ListingAccessFallback, browserListingJobSchema } from "../src/features/listing/dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const sourceUrl = "https://www.auto24.ee/soidukid/123456";

describe("listing dashboard UI", () => {
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
