import { describe, expect, it } from "vitest";
import { reportGate } from "@/features/listing/report-gate";

describe("report gate", () => {
  it.each([null, "queued", "running", "failed"] as const)("stays closed while the job is %s", (status) => {
    expect(reportGate(status, null)).toEqual({ enabled: false, reason: "notReady" });
  });

  it("opens when the details are ready and the service reports no identity", () => {
    expect(reportGate("completed", null)).toEqual({ enabled: true, reason: null });
  });

  it("waits for the registration number and VIN while either is pending", () => {
    expect(reportGate("completed", { registration: { state: "found", value: "123ABC" }, vin: { state: "pending" } })).toEqual({ enabled: false, reason: "waitingForIdentity" });
    expect(reportGate("completed", { registration: { state: "pending" }, vin: { state: "not_found" } })).toEqual({ enabled: false, reason: "waitingForIdentity" });
  });

  it("opens once each identity field is found or not found", () => {
    expect(reportGate("completed", { registration: { state: "found", value: "123ABC" }, vin: { state: "not_found" } })).toEqual({ enabled: true, reason: null });
  });

  it("can open before the identity arrives when waiting is turned off", () => {
    expect(reportGate("completed", { registration: { state: "pending" }, vin: { state: "pending" } }, false)).toEqual({ enabled: true, reason: null });
  });
});
