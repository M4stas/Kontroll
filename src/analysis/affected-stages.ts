import type { AnalysisStage } from "@/analysis/stages";

export interface Submission {
  kind: "seller_answer" | "buyer_note" | "image" | "screenshot" | "document";
  mimeType?: string;
  providedBy?: "seller" | "buyer";
  identityCorrection?: "vin" | "registrationPlate";
}

export function affectedStages(submission: Submission): AnalysisStage[] {
  if (submission.kind === "document" && submission.mimeType === "application/pdf") return ["enrich", "assemble_report"];
  if (submission.providedBy === "buyer" && (submission.kind === "buyer_note" || submission.kind === "screenshot")) {
    return ["capture_listing", "normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"];
  }
  if (submission.identityCorrection) {
    return ["normalize_identity", "baseline_checks", "research", "enrich", "assemble_report"];
  }
  if (submission.kind === "image" || submission.kind === "screenshot") {
    return ["enrich", "assemble_report"];
  }
  return ["baseline_checks", "enrich", "assemble_report"];
}
