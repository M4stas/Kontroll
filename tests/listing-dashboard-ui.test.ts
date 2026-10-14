import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListingAccessFallback, browserListingJobSchema } from "../src/features/listing/dashboard";
import { ReportActions } from "../src/features/submission/report-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const sourceUrl = "https://www.auto24.ee/soidukid/123456";

afterEach(cleanup);

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

describe("captured listing phone actions", () => {
  it("keeps captured actions in the phone bar and the manual form in page flow", () => {
    const { container } = render(
      createElement(ReportActions, {
        locale: "en",
        jobId: "job-123",
        note: createElement("p", null, "Reading the Auto24 listing"),
        phoneBottomBar: true,
      }),
    );
    const slot = container.querySelector(".phone-bottom-bar-slot");

    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).getByRole("button", { name: "Open inspection report" })).toBeInTheDocument();
    expect(within(slot as HTMLElement).getByText("Reading the Auto24 listing")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue manually" }));
    const form = container.querySelector(".manual-panel");
    expect(form).toBeInTheDocument();
    expect(slot?.contains(form)).toBe(false);
  });

  it("keeps standalone manual actions out of the phone bar", () => {
    const { container } = render(createElement(ReportActions, { locale: "en", listingUrl: sourceUrl }));

    expect(container.querySelector(".phone-bottom-bar-slot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue manually" }));
    expect(container.querySelector(".manual-panel")).toBeInTheDocument();
    expect(container.querySelector(".phone-bottom-bar-slot")).toBeNull();
  });
});
