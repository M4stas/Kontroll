import type { AnalysisReport, Finding } from "@/domain/analysis";

export const findingGroups = ["bodywork", "interior", "mechanical", "identity", "mileage", "equipment"] as const;
export type FindingGroup = typeof findingGroups[number];

export function findingGroup(finding: Finding): FindingGroup | null {
  const explicit = finding.category.toLowerCase();
  const categoryGroups: [FindingGroup, RegExp][] = [
    ["bodywork", /body|exterior|paint|panel|rust|corrosion|kere|värv|rooste/],
    ["interior", /interior|seat|cabin|upholstery|salong|istme|iste|polster/],
    ["mechanical", /mechanic|engine|gearbox|transmission|service|maintenance|brake|tyre|tire|mootor|käigukast|hooldus|pidur|rehv/],
    ["mileage", /mileage|odometer|inspection|coverage|läbisõit|odomeeter|ülevaatus/],
    ["equipment", /equipment|feature|option|varustus/],
    ["identity", /identity|history|vin|identiteet|ajalugu/],
  ];
  const knownCategory = categoryGroups.find(([, pattern]) => pattern.test(explicit));
  if (knownCategory) return knownCategory[0];

  const subjectGroups: [FindingGroup, RegExp][] = [
    ["mileage", /mileage|odometer|inspection|coverage|technical[- ]check|\bkm\b|läbisõit|odomeeter|ülevaatus/],
    ["interior", /interior|seat|cabin|upholstery|cargo[- ]area|carpet|door pull|trim|gear[- ]selector.*surface|salong|istme|iste|polster/],
    ["equipment", /equipment|feature|option|speaker|infotainment|display|dashboard|instrument[- ]cluster|battery[- ]shaped.*indicator|comfort controls|camera|lighting|headlamp|headlight|taillight|door[- ]open|varustus/],
    ["bodywork", /bodywork|exterior|paint|panel|rust|corrosion|underbody|underside|lower[- ]body|body[- ]style|towbar|front and side surfaces|tailgate|bumper|quarter|hood|bonnet|wheel arch|front view|kere|värv|rooste/],
    ["mechanical", /mechanic|engine|gearbox|transmission|service|maintenance|brake|tyre|tire|mootor|käigukast|hooldus|pidur|rehv/],
    ["identity", /identity|history|registration|import details|\bvin\b|identiteet|ajalugu/],
  ];
  // Match the observed subject before caveats, treating speed separately from mileage.
  const subjectOf = (text: string) => text.toLowerCase()
    .split(/[.;]|\b(?:but|however|although|whereas|yet)\b/)[0]!
    .replace(/\bkm\s*\/\s*h\b/g, "");
  const titleGroup = subjectGroups.find(([, pattern]) => pattern.test(subjectOf(finding.title)));
  if (titleGroup) return titleGroup[0];
  const observedSubject = subjectOf(finding.explanation);
  return explicit === "image_observation"
    ? subjectGroups.find(([, pattern]) => pattern.test(observedSubject))?.[0] ?? null
    : null;
}

export function selectPrimaryFindings(report: AnalysisReport): Finding[] {
  const openFindings = report.findings.filter((finding) => finding.state !== "cleared");

  const priorityFindings = [...openFindings].sort((a, b) =>
    ({ critical: 0, important: 1, context: 2 }[a.severity]) -
    ({ critical: 0, important: 1, context: 2 }[b.severity])
  );

  // Keep distinct subjects in the short review, without dropping critical checks.
  const uniqueFindings = priorityFindings.filter((finding, index, items) =>
    finding.severity === "critical" ||
    items.findIndex(item => item.title === finding.title && item.explanation === finding.explanation) === index
  );
  const primaryFindings: Finding[] = [];
  const primaryGroups = new Set<FindingGroup | null>();
  for (const finding of uniqueFindings) {
    const group = findingGroup(finding);
    if (finding.severity === "critical" || (primaryFindings.length < 3 && !primaryGroups.has(group))) {
      primaryFindings.push(finding);
      primaryGroups.add(group);
    }
  }
  for (const finding of uniqueFindings) {
    if (primaryFindings.length >= 3) break;
    if (!primaryFindings.includes(finding)) primaryFindings.push(finding);
  }

  const isPhotoObservation = (finding: Finding) =>
    ["bodywork", "interior", "equipment"].includes(findingGroup(finding) ?? "") &&
    finding.evidenceIds.some(id => report.evidence.some(item => item.id === id && item.imageUrl));
  if (!primaryFindings.some(isPhotoObservation)) {
    const photoObservation = uniqueFindings.find(finding =>
      isPhotoObservation(finding) && !primaryGroups.has(findingGroup(finding))
    ) ?? uniqueFindings.find(isPhotoObservation);
    if (photoObservation) primaryFindings.push(photoObservation);
  }

  return primaryFindings;
}
