import { describe, expect, it } from "vitest";
import { affectedStages } from "@/analysis/affected-stages";

describe("affectedStages", () => {
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
