import { describe, expect, it } from "vitest";
import { jobSchema, listingSchema } from "../src/listings/contracts";
import { ReviewInputSchema } from "../src/insights/provider";
import { reviewerEvaluationCases } from "./fixtures/reviewer-evaluations";

const validListing = { source_url: "https://www.auto24.ee/soidukid/1", listing_id: "1" };
const registration = { reg_number: "123ABC", reg_number_status: "revealed", vin: null, vin_status: "not_listed", vin_format: null };

describe("registration fields from the extraction service", () => {
  it("listing schema keeps registration", () => {
    const parsed = listingSchema.parse({ ...validListing, registration });
    expect(parsed.registration).toEqual(registration);
  });

  it("pending registration parses", () => {
    const pending = { reg_number: null, reg_number_status: "pending", vin: null, vin_status: "pending", vin_format: null };
    expect(listingSchema.parse({ ...validListing, registration: pending }).registration).toEqual(pending);
  });

  it.each([undefined, null])("old listing registration defaults to null (%s)", registration => {
    expect(listingSchema.parse({ ...validListing, registration }).registration).toBeNull();
  });

  it.each(["listed_in_full", "revealed"])("keeps values with %s status", status => {
    const identity = { reg_number: "123ABC", reg_number_status: status, vin: "WVWZZZ1KZAW000001", vin_status: status, vin_format: "standard" };
    expect(listingSchema.parse({ ...validListing, registration: identity }).registration).toEqual(identity);
  });

  it.each(["not_listed", "unavailable", "pending"])("value without a value status is rejected (%s)", status => {
    for (const field of ["reg_number", "vin"] as const) {
      const identity = { reg_number: null, reg_number_status: "not_listed", vin: null, vin_status: "not_listed", vin_format: null,
        [field]: field === "vin" ? "WVWZZZ1KZAW000001" : "123ABC", [`${field}_status`]: status };
      expect(listingSchema.safeParse({ ...validListing, registration: identity }).success).toBe(false);
    }
  });

  it.each(["listed_in_full", "revealed"])("missing value with %s status is rejected", status => {
    for (const field of ["reg_number", "vin"]) {
      const identity = { reg_number: null, reg_number_status: "not_listed", vin: null, vin_status: "not_listed", vin_format: null, [`${field}_status`]: status };
      expect(listingSchema.safeParse({ ...validListing, registration: identity }).success).toBe(false);
    }
  });

  it("job schema accepts and drops reveal_diagnostics", () => {
    const parsed = jobSchema.parse({
      job_id: "job-1", status: "completed", submitted_at: "2026-09-26T14:28:00Z", parsed_at: "2026-09-26T14:28:18Z",
      listing: { ...validListing, registration }, error: null, warnings: [],
      reveal_diagnostics: { attempts: [{ attempt: 1, outcome: "no_captcha_needed", duration_ms: 5 }] },
    });
    expect(parsed).not.toHaveProperty("reveal_diagnostics");
    expect(parsed.listing?.registration).toEqual(registration);
  });
});

it("reviewer accepts and keeps the captured registration block", () => {
  const input = reviewerEvaluationCases.find(item => item.input.listing !== null)!.input;
  const listing = listingSchema.parse({ ...input.listing, registration });
  const parsed = ReviewInputSchema.safeParse({ ...input, listing });
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("Expected valid reviewer input");
  expect(parsed.data.listing?.registration).toEqual(registration);
});
