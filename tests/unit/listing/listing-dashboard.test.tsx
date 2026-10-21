import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";
import { ListingDashboard } from "@/features/listing/dashboard";
import { listingText } from "@/features/listing/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const sourceUrl = "https://www.auto24.ee/soidukid/123456";
const listing = {
  source_url: sourceUrl, listing_id: "123456", title: "Electric estate", make: "Example", model: "Touring",
  year: 2022, year_source: "first_registration", first_registration: "2022-03", price: { amount: 41_500, currency: "EUR" },
  mileage_km: 46_800, fuel: "electric", power_kw: 195, gearbox: "automatic", drivetrain: "all-wheel drive",
  body_type: "estate", colour: "black", seller_description: "Synthetic description.", seller: null,
  equipment: {}, technical_specs: {}, other_fields: {}, photo_urls: ["https://images.example/1.jpg", "https://images.example/2.jpg"],
};

function respondWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("listing dashboard", () => {
  it("shows the reading state with a disabled report button", async () => {
    respondWith({ job_id: "job-1", status: "running", submitted_at: "2026-10-11T10:00:00Z", source_url: sourceUrl });
    const { container } = render(<ListingDashboard locale="en" jobId="job-1" />);
    expect(await screen.findByText(listingText("en", "runningTitle"))).toBeInTheDocument();
    expect(container.querySelector(".listing-photo.is-reading")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open inspection report" })).toBeDisabled();
    expect(container.querySelector("#listing-details")).toBeNull();
  });

  it("fills the card and the closed details section when the capture completes", async () => {
    respondWith({ job_id: "job-1", status: "completed", submitted_at: "2026-10-11T10:00:00Z", parsed_at: "2026-10-11T10:00:12Z", listing, warnings: ["A seller field was not available."] });
    const { container } = render(<ListingDashboard locale="en" jobId="job-1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Electric estate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open inspection report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "1 note from Auto24" })).toBeInTheDocument();
    expect(screen.getByText(listingText("en", "completeHelp"))).toBeInTheDocument();
    expect((container.querySelector("#listing-details") as HTMLDetailsElement).open).toBe(false);
  });

  it("replaces the layout with the failure message when the capture fails", async () => {
    respondWith({ job_id: "job-1", status: "failed", submitted_at: "2026-10-11T10:00:00Z", source_url: sourceUrl, error: { code: "listing_gone" } });
    const { container } = render(<ListingDashboard locale="en" jobId="job-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(listingText("en", "listingGone"));
    expect(screen.getByRole("link", { name: listingText("en", "tryAnother") })).toBeInTheDocument();
    expect(container.querySelector(".listing-card")).toBeNull();
    expect(screen.queryByText(listingText("en", "unavailable"))).toBeNull();
  });

  describe("live diagnostics", () => {
    const withIntl = (enabled: boolean) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <ListingDashboard locale="en" jobId="job-1" diagnosticsEnabled={enabled} />
      </NextIntlClientProvider>
    );

    it("listing card shows Live diagnostics below the report button when enabled", async () => {
      respondWith({ job_id: "job-1", status: "running", submitted_at: "2026-10-11T10:00:00Z", source_url: sourceUrl });
      const { container } = render(withIntl(true));
      await screen.findByText(listingText("en", "runningTitle"));
      const trigger = screen.getByRole("button", { name: "Live diagnostics" });
      const report = screen.getByRole("button", { name: "Open inspection report" });
      expect(container.querySelector(".listing-card")?.contains(trigger)).toBe(true);
      expect(report.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(trigger).toHaveClass("secondary-button");
    });

    it("failed capture section shows Live diagnostics when enabled", async () => {
      respondWith({ job_id: "job-1", status: "failed", submitted_at: "2026-10-11T10:00:00Z", source_url: sourceUrl, error: { code: "listing_gone" } });
      render(withIntl(true));
      const failed = await screen.findByRole("alert");
      expect(failed).toContainElement(screen.getByRole("button", { name: "Live diagnostics" }));
    });

    it("no diagnostics trigger when disabled", async () => {
      respondWith({ job_id: "job-1", status: "running", submitted_at: "2026-10-11T10:00:00Z", source_url: sourceUrl });
      render(withIntl(false));
      await screen.findByText(listingText("en", "runningTitle"));
      expect(screen.queryByRole("button", { name: "Live diagnostics" })).toBeNull();
    });
  });
});
