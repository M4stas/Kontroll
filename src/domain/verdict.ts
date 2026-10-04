import type { ConfidenceBand, Finding, Verdict } from "@/domain/analysis";

export function calculateVerdict(findings: Finding[], confidence: ConfidenceBand): Verdict {
  if (findings.some((finding) => finding.severity === "critical" && finding.state === "confirmed")) {
    return "likely_skip";
  }

  const confirmedImportantCount = findings.filter(
    (finding) => finding.severity === "important" && finding.state === "confirmed",
  ).length;

  if (confirmedImportantCount >= 2) {
    return "likely_skip";
  }

  if (
    findings.some(
      (finding) =>
        (finding.severity === "critical" && finding.state === "open") ||
        (finding.severity === "important" &&
          (finding.state === "confirmed" || finding.state === "open")),
    )
  ) {
    return "proceed_cautiously";
  }

  if (confidence === "low") {
    return "proceed_cautiously";
  }

  return "worth_viewing";
}
