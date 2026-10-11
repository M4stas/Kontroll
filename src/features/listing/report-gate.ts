export type IdentityField =
  | { state: "pending" }
  | { state: "found"; value: string }
  | { state: "not_found" };

export interface ListingIdentity {
  registration: IdentityField;
  vin: IdentityField;
}

type JobStatus = "queued" | "running" | "completed" | "failed" | null;

// The inspection report waits for the registration number and VIN. Set this to
// false to let the report open while they are still being looked up.
export const WAIT_FOR_IDENTITY = true;

export function reportGate(
  status: JobStatus,
  identity: ListingIdentity | null,
  waitForIdentity = WAIT_FOR_IDENTITY,
): { enabled: boolean; reason: "notReady" | "waitingForIdentity" | null } {
  if (status !== "completed") return { enabled: false, reason: "notReady" };
  // The extraction service does not report identity fields yet; null means not applicable.
  if (identity && waitForIdentity && (identity.registration.state === "pending" || identity.vin.state === "pending")) {
    return { enabled: false, reason: "waitingForIdentity" };
  }
  return { enabled: true, reason: null };
}
