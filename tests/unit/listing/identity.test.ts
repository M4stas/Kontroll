import { describe, it, expect } from "vitest";
import { jobSchema, type Registration } from "../../../src/listings/contracts";
import { listingIdentity, identitySettled } from "../../../src/features/listing/identity";

const makeJob = (status: string, registration: unknown = undefined) => jobSchema.parse({ job_id: "job-123", status: "completed", submitted_at: "2026-10-21T00:00:00Z", parsed_at: "2026-10-21T00:00:01Z", listing: { source_url: "https://www.auto24.ee/soidukid/1", listing_id: "1", registration: registration ?? {reg_number: status === "revealed" || status === "listed_in_full" ? "123ABC" : null, reg_number_status: status, vin: null, vin_status: "not_listed", vin_format: null} } });
describe("listing identity", () => {
  it.each(["revealed", "listed_in_full", "not_listed", "unavailable", "pending"])("maps %s", status => {
    const job = makeJob(status);
    expect(listingIdentity(job, false)?.registration).toEqual(status === "pending" ? {state:"pending"} : status === "revealed" || status === "listed_in_full" ? {state:"found",value:"123ABC"} : {state:"not_found"});
    expect(identitySettled(job)).toBe(status !== "pending");
    job.listing!.registration = {reg_number:null,reg_number_status:"not_listed",vin:status === "revealed" || status === "listed_in_full" ? "WVWZZZ1KZAW000001" : null,vin_status:status as Registration["vin_status"],vin_format:null};
    expect(listingIdentity(job,false)?.vin).toEqual(status === "pending" ? {state:"pending"} : status === "revealed" || status === "listed_in_full" ? {state:"found",value:"WVWZZZ1KZAW000001"} : {state:"not_found"});
    expect(identitySettled(job)).toBe(status !== "pending");
  });
  it("expires only pending fields and preserves found fields", () => {
    const job = makeJob("revealed", {reg_number:"123ABC",reg_number_status:"revealed",vin:null,vin_status:"pending",vin_format:null});
    expect(listingIdentity(job, true)).toEqual({registration:{state:"found",value:"123ABC"},vin:{state:"not_found"}});
  });
  it("test_job_without_registration_has_no_identity", () => {
    for (const registration of [undefined,null]) {
      const job = makeJob("pending"); job.listing!.registration = registration as null;
      expect(listingIdentity(job,false)).toBeNull(); expect(identitySettled(job)).toBe(true);
    }
    expect(listingIdentity(null,false)).toBeNull();
    for (const status of ["queued", "running", "failed"] as const) {
      const job = makeJob("pending"); job.status = status;
      expect(listingIdentity(job,false)).toBeNull(); expect(identitySettled(job)).toBe(false);
    }
  });
});
