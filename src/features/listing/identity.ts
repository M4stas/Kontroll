import type { ListingJob, Registration } from "../../listings/contracts";
import type { IdentityField, ListingIdentity } from "./report-gate";

export const REVEAL_SECONDS = 120;

export function listingIdentity(job: ListingJob | null, revealExpired: boolean): ListingIdentity | null {
  const registration = job?.status === "completed" ? job.listing?.registration : null;
  if (!registration) return null;
  function field(status: Registration["reg_number_status"], value: string | null): IdentityField {
    if (status === "pending" && !revealExpired) return { state: "pending" };
    if ((status === "listed_in_full" || status === "revealed") && value !== null) return { state: "found", value };
    return { state: "not_found" };
  }
  return { registration: field(registration.reg_number_status, registration.reg_number), vin: field(registration.vin_status, registration.vin) };
}

export function identitySettled(job: ListingJob): boolean {
  if (job.status !== "completed") return false;
  const registration = job.listing?.registration;
  return !registration || (registration.reg_number_status !== "pending" && registration.vin_status !== "pending");
}
