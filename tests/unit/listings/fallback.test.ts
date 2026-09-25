import { describe, expect, it } from "vitest";
import { createFallbackSnapshot } from "@/listings/fallback";

describe("createFallbackSnapshot", () => {
  it("extracts labeled buyer-pasted listing facts without verifying them", () => {
    const snapshot = createFallbackSnapshot({
      originalListingUrl: new URL("https://www.auto24.ee/soidukid/123456"),
      pastedDescription: "Mark: Volvo\nMudel: V60\nAasta: 2018\nLäbisõit: 145 000 km\nKäigukast: automaat\nVIN: YV1ZW12ABC1234567",
    });
    expect(snapshot.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "make", value: "Volvo", verification: "unverified", confidence: 0.5 }),
      expect.objectContaining({ key: "model", value: "V60", verification: "unverified" }),
      expect.objectContaining({ key: "year", value: "2018", verification: "unverified" }),
      expect.objectContaining({ key: "mileage", value: "145 000 km", verification: "unverified" }),
      expect.objectContaining({ key: "gearbox", value: "automaat", verification: "unverified" }),
      expect.objectContaining({ key: "vin", value: "YV1ZW12ABC1234567", verification: "unverified" }),
    ]));
  });
  // Catches a fallback regression that loses the listing context, treats buyer content as trusted,
  // or silently turns absent vehicle details into a clean assessment.
  it("keeps pasted content and screenshots as incomplete unverified buyer input", () => {
    const snapshot = createFallbackSnapshot({
      originalListingUrl: new URL("https://www.auto24.ee/soidukid/123456"),
      pastedDescription: "Müüja ütles, et mootor on korras.",
      screenshotRefs: ["uploads/screenshot-1.png", "uploads/screenshot-2.png"],
    });

    expect(snapshot).toMatchObject({
      type: "snapshot",
      marketplace: "fallback",
      sourceUrl: "https://www.auto24.ee/soidukid/123456",
      description: "Müüja ütles, et mootor on korras.",
      screenshotRefs: ["uploads/screenshot-1.png", "uploads/screenshot-2.png"],
      facts: [],
      warnings: ["Buyer-provided fallback content is unverified; missing fields are not evidence of a clean vehicle."],
    });
    expect(snapshot.claims).toEqual([
      expect.objectContaining({
        text: "Müüja ütles, et mootor on korras.",
        sourceClass: "buyer",
        verification: "unverified",
      }),
    ]);
  });
});
