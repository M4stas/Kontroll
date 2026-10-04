import { describe, expect, it } from "vitest";
import { affectedStages } from "@/analysis/affected-stages";

describe("affectedStages", () => {
  it("recaptures and reruns the baseline for buyer-supplied listing fallback", () => {
    expect(affectedStages({ kind: "buyer_note", providedBy: "buyer" })).toEqual([
      "capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report",
    ]);
    expect(affectedStages({ kind: "screenshot", providedBy: "buyer" })).toEqual([
      "capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report",
    ]);
  });
  // Catches a supplement rerun wasting work by recapturing an unchanged listing.
  it("limits image evidence to enrichment and reassembly", () => {
    expect(affectedStages({ kind: "image" })).toEqual(["enrich", "assemble_report"]);
  });

  // Catches a corrected official-check identity leaving stale normalization and research outputs active.
  it("reruns every identity-dependent stage after a VIN or plate correction", () => {
    expect(affectedStages({ kind: "seller_answer", identityCorrection: "vin" })).toEqual([
      "normalize_identity",
      "baseline_checks",
      "research",
      "enrich",
      "assemble_report",
    ]);
  });
});
