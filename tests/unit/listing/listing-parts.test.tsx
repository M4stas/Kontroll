import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { listingSchema, type Listing } from "@/listings/contracts";
import { ListingGallery } from "@/features/listing/listing-gallery";
import { ListingCard } from "@/features/listing/listing-card";
import { ListingDetails } from "@/features/listing/listing-details";
import { listingText } from "@/features/listing/messages";

afterEach(cleanup);

const sourceUrl = "https://www.auto24.ee/soidukid/123456";

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    ...listingSchema.parse({
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
    }),
    ...overrides,
  };
}

const photos = (count: number) => Array.from({ length: count }, (_, index) => `https://images.example/${index + 1}.jpg`);

describe("listing gallery", () => {
  it("shows a scanning photo slot and pulsing thumbnails while the listing is read", () => {
    const { container } = render(<ListingGallery locale="en" photoUrls={null} />);
    expect(container.querySelector(".listing-photo.is-reading")).not.toBeNull();
    expect(container.querySelectorAll(".listing-thumbs .pulse")).toHaveLength(5);
    expect(screen.getByText(listingText("en", "unavailableForNow"))).toBeInTheDocument();
  });

  it("shows four thumbnails and a more tile when there are many photos", () => {
    render(<ListingGallery locale="en" photoUrls={photos(18)} />);
    expect(screen.getAllByRole("button", { name: /Show photo/ })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "+14 photos" })).toBeInTheDocument();
  });

  it("swaps the large photo when a thumbnail is pressed", () => {
    const { container } = render(<ListingGallery locale="en" photoUrls={photos(3)} />);
    const desktopPhoto = () => container.querySelector(".listing-gallery > .listing-photo") as HTMLAnchorElement;
    expect(desktopPhoto()).toHaveAttribute("href", "https://images.example/1.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Show photo 3" }));
    expect(desktopPhoto()).toHaveAttribute("href", "https://images.example/3.jpg");
    expect(screen.getByRole("button", { name: "Show photo 3" })).toHaveAttribute("aria-pressed", "true");
  });

  it("drops unsafe photo URLs and says so when none remain", () => {
    const { container } = render(<ListingGallery locale="en" photoUrls={["javascript:alert(1)", "data:image/png;base64,a"]} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector(".listing-gallery > .listing-photo.is-empty")).toHaveTextContent(listingText("en", "noPhotos"));
  });

  it("hides the thumbnail row for a single photo", () => {
    const { container } = render(<ListingGallery locale="en" photoUrls={photos(1)} />);
    expect(container.querySelector(".listing-thumbs")).toBeNull();
  });

  it("updates the phone gallery count as the user scrolls between photos", () => {
    const { container } = render(<ListingGallery locale="en" photoUrls={photos(3)} />);
    const track = container.querySelector(".listing-phone-track") as HTMLDivElement | null;

    expect(track).not.toBeNull();
    if (!track) throw new Error("Phone gallery track did not render");
    expect(container.querySelector(".listing-phone-count")).toHaveTextContent("1 / 3");

    Object.defineProperty(track, "clientWidth", { configurable: true, value: 320 });
    track.scrollLeft = 320;
    fireEvent.scroll(track);

    expect(container.querySelector(".listing-phone-count")).toHaveTextContent("2 / 3");
  });
});

describe("listing card", () => {
  it("shows the title, figures, key details, source and captured time", () => {
    render(<ListingCard locale="en" listing={listing()} waiting={false} sourceUrl={sourceUrl} capturedAt="2026-09-29T08:00:12.000Z" warningCount={0} identity={null}>actions</ListingCard>);
    expect(screen.getByRole("heading", { level: 1, name: "Electric estate" })).toBeInTheDocument();
    expect(screen.getByText("41,500 EUR · 46,800 km · 2022")).toBeInTheDocument();
    expect(screen.getByText("electric · automatic · 195 kW · estate")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: listingText("en", "source") })).toHaveAttribute("href", sourceUrl);
    expect(screen.getByText(/^Captured /)).toBeInTheDocument();
    expect(screen.getByText("actions")).toBeInTheDocument();
  });

  it("leaves out missing figures instead of printing placeholders", () => {
    render(<ListingCard locale="en" listing={listing({ price: null, fuel: null, gearbox: null })} waiting={false} sourceUrl={null} capturedAt={null} warningCount={0} identity={null}>{null}</ListingCard>);
    expect(screen.getByText("46,800 km · 2022")).toBeInTheDocument();
    expect(screen.getByText("195 kW · estate")).toBeInTheDocument();
    expect(screen.queryByText(listingText("en", "unavailable"))).toBeNull();
  });

  it("shows pulsing placeholders while the listing is read", () => {
    const { container } = render(<ListingCard locale="et" listing={null} waiting sourceUrl={sourceUrl} capturedAt={null} warningCount={0} identity={null}>{null}</ListingCard>);
    expect(container.querySelectorAll(".listing-head .pulse")).toHaveLength(2);
    expect(screen.getByRole("link", { name: listingText("et", "source") })).toHaveAttribute("href", sourceUrl);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("links Auto24 notes to the details section", () => {
    render(<ListingCard locale="en" listing={listing()} waiting={false} sourceUrl={sourceUrl} capturedAt={null} warningCount={2} identity={null}>{null}</ListingCard>);
    expect(screen.getByRole("button", { name: "2 notes from Auto24" })).toBeInTheDocument();
  });

  it("hides the identity rows until the service reports them", () => {
    render(<ListingCard locale="en" listing={listing()} waiting={false} sourceUrl={sourceUrl} capturedAt={null} warningCount={0} identity={null}>{null}</ListingCard>);
    expect(screen.queryByText(listingText("en", "registration"))).toBeNull();
  });

  it("pulses a pending identity field and shows found and missing values", () => {
    const { container } = render(<ListingCard locale="en" listing={listing()} waiting={false} sourceUrl={sourceUrl} capturedAt={null} warningCount={0}
      identity={{ registration: { state: "found", value: "123 ABC" }, vin: { state: "pending" } }}>{null}</ListingCard>);
    const rows = container.querySelector(".listing-identity") as HTMLElement;
    expect(within(rows).getByText("123 ABC")).toBeInTheDocument();
    expect(rows.querySelectorAll(".pulse")).toHaveLength(1);
    cleanup();
    render(<ListingCard locale="en" listing={listing()} waiting={false} sourceUrl={sourceUrl} capturedAt={null} warningCount={0}
      identity={{ registration: { state: "found", value: "123 ABC" }, vin: { state: "not_found" } }}>{null}</ListingCard>);
    expect(screen.getByText(listingText("en", "identityNotFound"))).toBeInTheDocument();
  });
});

describe("listing details", () => {
  it("is closed and holds every group the old page showed", () => {
    const { container } = render(<ListingDetails locale="en" listing={listing({ photo_urls: photos(3) })} sourceUrl={sourceUrl} capturedAt="2026-09-29T08:00:12.000Z" warnings={["A seller field was not available."]} />);
    const details = container.querySelector("details#listing-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText(listingText("en", "allDetails"))).toBeInTheDocument();
    for (const text of [
      "A seller field was not available.",
      "Synthetic description for UI coverage.",
      "Sample seller",
      "Heated seats",
      "77 kWh",
      "Estonia",
      "Touring",
      "all-wheel drive",
      "2022-03",
      "123456",
    ]) expect(container.textContent).toContain(text);
    expect(container.querySelectorAll("#all-photos img")).toHaveLength(3);
    expect(container.querySelector(`a[href="${sourceUrl}"]`)).not.toBeNull();
  });
});
