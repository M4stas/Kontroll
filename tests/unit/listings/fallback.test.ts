import { describe, expect, it } from "vitest";
import { createFallbackSnapshot } from "@/listings/fallback";

describe("createFallbackSnapshot", () => {
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
