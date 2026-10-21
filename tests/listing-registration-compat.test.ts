import { describe, expect, it } from "vitest";
import { jobSchema, listingSchema } from "../src/listings/contracts";

const validListing = { source_url: "https://www.auto24.ee/soidukid/1", listing_id: "1" };
const registration = { reg_number: "123ABC", reg_number_status: "revealed", vin: null, vin_status: "not_listed", vin_format: null };

describe("registration fields from the extraction service", () => {
  it("listing schema accepts and drops registration", () => {
    const parsed = listingSchema.parse({ ...validListing, registration });
    expect(parsed).not.toHaveProperty("registration");
  });

  it("job schema accepts and drops reveal_diagnostics", () => {
    const parsed = jobSchema.parse({
      job_id: "job-1", status: "completed", submitted_at: "2026-09-26T14:28:00Z", parsed_at: "2026-09-26T14:28:18Z",
      listing: { ...validListing, registration }, error: null, warnings: [],
      reveal_diagnostics: { attempts: [{ attempt: 1, outcome: "no_captcha_needed", duration_ms: 5 }] },
    });
    expect(parsed).not.toHaveProperty("reveal_diagnostics");
    expect(parsed.listing).not.toHaveProperty("registration");
  });
});
