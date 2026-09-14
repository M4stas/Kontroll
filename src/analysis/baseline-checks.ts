import { createHash } from "node:crypto";
import type { Action, Evidence, Finding, SourceClass } from "@/domain/analysis";
import type { ListingClaim, ListingSnapshot } from "@/listings/adapter";
import type { NormalizedVehicle, NormalizedFieldValue } from "@/analysis/normalize";

export interface BaselineResult {
  evidence: Evidence[];
  findings: Finding[];
  actions: Action[];
}

type RuleName =
  | "unsupported-major-maintenance"
  | "missing-gearbox-service-detail"
  | "listing-mileage-disagreement"
  | "missing-official-check-identity"
  | "missing-inspection-images"
  | "no-investment-without-maintenance-evidence";

function deterministicId(snapshot: ListingSnapshot, entity: string, rule: RuleName, detail = ""): string {
  const hash = createHash("sha256")
    .update(`${snapshot.contentHash}\n${entity}\n${rule}\n${detail}`)
    .digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function evidenceForClaim(
  snapshot: ListingSnapshot,
  rule: RuleName,
  claim: string,
  sourceClass: SourceClass,
): Evidence {
  return {
    id: deterministicId(snapshot, "evidence", rule, claim),
    sourceId: snapshot.sourceId,
    sourceClass,
    sourceUrl: snapshot.sourceUrl,
    claim,
    applicability: "Listing or seller statement requiring independent verification.",
    confidence: 0.5,
    verification: "unverified",
    capturedAt: snapshot.capturedAt,
  };
}

function evidenceForAbsence(snapshot: ListingSnapshot, rule: RuleName, claim: string): Evidence {
  return {
    id: deterministicId(snapshot, "evidence", rule, claim),
    sourceId: snapshot.sourceId,
    sourceClass: "listing",
    sourceUrl: snapshot.sourceUrl,
    claim,
    applicability: "Deterministic observation of what the listing snapshot does not provide.",
    confidence: 0.5,
    verification: "unverified",
    capturedAt: snapshot.capturedAt,
  };
}

function evidenceForMileage(
  snapshot: ListingSnapshot,
  rule: RuleName,
  value: NormalizedFieldValue,
): Evidence {
  return {
    id: deterministicId(snapshot, "evidence", rule, `${value.value}:${value.sourceIds.join(",")}`),
    sourceId: value.sourceIds[0] ?? snapshot.sourceId,
    sourceClass: "listing",
    sourceUrl: snapshot.sourceUrl,
    claim: `Listing mileage fact: ${value.value} km.`,
    applicability: "Conflicting odometer values require independent verification.",
    confidence: 0.5,
    verification: "contradicted",
    capturedAt: snapshot.capturedAt,
  };
}

function addFinding(
  result: BaselineResult,
  snapshot: ListingSnapshot,
  rule: RuleName,
  category: string,
  title: string,
  explanation: string,
  nextAction: string,
  evidence: Evidence[],
  action: Pick<Action, "kind" | "title" | "instructions">,
): void {
  const findingId = deterministicId(snapshot, "finding", rule);
  result.evidence.push(...evidence);
  result.findings.push({
    id: findingId,
    category,
    severity: "important",
    state: "open",
    title,
    explanation,
    nextAction,
    evidenceIds: evidence.map((item) => item.id),
    origin: "deterministic",
  });
  result.actions.push({
    id: deterministicId(snapshot, "action", rule),
    ...action,
    status: "open",
    findingId,
  });
}

function firstMatchingClaim(snapshot: ListingSnapshot, pattern: RegExp): ListingClaim | undefined {
  return snapshot.claims.find((claim) => pattern.test(claim.text));
}

function listingStatement(
  snapshot: ListingSnapshot,
  pattern: RegExp,
): { text: string; sourceClass: SourceClass } | undefined {
  const claim = firstMatchingClaim(snapshot, pattern);
  if (claim) return { text: claim.text, sourceClass: claim.sourceClass };
  if (pattern.test(snapshot.description)) return { text: snapshot.description, sourceClass: "listing" };
  return undefined;
}

function hasGearboxServiceDetail(snapshot: ListingSnapshot): boolean {
  const text = [snapshot.description, ...snapshot.claims.map((claim) => claim.text)].join(" ").toLocaleLowerCase("et");
  return /(?:käigukast|gearbox|transmission|dsg).{0,80}(?:hooldus|õli|oil|service|vahet|changed)|(?:hooldus|õli|oil|service|vahet|changed).{0,80}(?:käigukast|gearbox|transmission|dsg)/.test(text);
}

function missingImageCategories(imageUrls: string[]): string[] {
  const allImages = imageUrls.join(" ").toLocaleLowerCase("et");
  const categories = [
    ["underside", /underside|underbody|põhi/],
    ["engine-bay", /engine[-_ ]?bay|mootoriruum|engine/],
    ["instrument-cluster", /instrument[-_ ]?cluster|dashboard|odometer|spidomeeter/],
    ["service-document", /service[-_ ]?(?:book|record|document)|hooldus(?:raamat|dokument)/],
  ] as const;
  return categories.filter(([, pattern]) => !pattern.test(allImages)).map(([name]) => name);
}

export function runBaselineChecks(vehicle: NormalizedVehicle, snapshot: ListingSnapshot): BaselineResult {
  const result: BaselineResult = { evidence: [], findings: [], actions: [] };
  const majorMaintenance = listingStatement(snapshot, /suur\s+hooldus|major\s+(?:service|maintenance)/i);
  if (majorMaintenance) {
    addFinding(
      result,
      snapshot,
      "unsupported-major-maintenance",
      "unsupported_major_maintenance",
      "Major maintenance claim needs documentation",
      "The listing states that major maintenance was completed, but the statement is unverified.",
      "Request invoices or service records for the claimed work.",
      [evidenceForClaim(snapshot, "unsupported-major-maintenance", majorMaintenance.text, majorMaintenance.sourceClass)],
      {
        kind: "document_request",
        title: "Request major-service documentation",
        instructions: "Ask the seller for invoices or service records that identify the completed major maintenance.",
      },
    );
  }

  if (vehicle.transmission === "automatic" && !hasGearboxServiceDetail(snapshot)) {
    addFinding(
      result,
      snapshot,
      "missing-gearbox-service-detail",
      "missing_gearbox_service_detail",
      "Automatic gearbox service detail is missing",
      "The listing identifies an automatic transmission but provides no gearbox service detail.",
      "Ask when the gearbox oil and related service were last completed.",
      [evidenceForAbsence(snapshot, "missing-gearbox-service-detail", "Automatic transmission is listed without gearbox service detail.")],
      {
        kind: "seller_question",
        title: "Ask about gearbox service",
        instructions: "Ask for the gearbox type, the last service date, mileage, and supporting invoice.",
      },
    );
  }

  const mileageConflict = vehicle.conflicts.find((conflict) => conflict.field === "mileageKm");
  if (mileageConflict) {
    addFinding(
      result,
      snapshot,
      "listing-mileage-disagreement",
      "listing_mileage_disagreement",
      "Listing mileage values disagree",
      "Distinct listing facts provide conflicting odometer readings, so the mileage remains unresolved.",
      "Verify the odometer reading and its history during inspection.",
      mileageConflict.values.map((value) => evidenceForMileage(snapshot, "listing-mileage-disagreement", value)),
      {
        kind: "inspection_task",
        title: "Verify mileage history",
        instructions: "Compare the odometer, service records, and official history against the conflicting listing values.",
      },
    );
  }

  if (!vehicle.vin && !vehicle.registrationPlate) {
    addFinding(
      result,
      snapshot,
      "missing-official-check-identity",
      "missing_official_check_identity",
      "Official-check identity is missing",
      "The listing provides neither a VIN nor a registration plate for official checks.",
      "Request a VIN or registration plate before relying on official history checks.",
      [evidenceForAbsence(snapshot, "missing-official-check-identity", "Listing snapshot has neither a VIN nor a registration plate for official checks.")],
      {
        kind: "seller_question",
        title: "Request VIN or registration plate",
        instructions: "Ask the seller to provide either the VIN or the registration plate for official checks.",
      },
    );
  }

  const missingPhotos = missingImageCategories(snapshot.imageUrls);
  if (missingPhotos.length > 0) {
    addFinding(
      result,
      snapshot,
      "missing-inspection-images",
      "missing_inspection_images",
      "Inspection image coverage is incomplete",
      `The listing lacks ${missingPhotos.join(", ")} image coverage needed for a basic remote review.`,
      "Request the missing underside, engine-bay, instrument-cluster, and service-document photos.",
      [evidenceForAbsence(snapshot, "missing-inspection-images", `Listing snapshot lacks ${missingPhotos.join(", ")} images.`)],
      {
        kind: "photo_request",
        title: "Request inspection photos",
        instructions: "Request clear underside, engine-bay, instrument-cluster, and service-document photos.",
      },
    );
  }

  const noInvestmentStatement = listingStatement(snapshot, /(?:ei\s+vaja\s+lisainvesteeringuid|lisainvesteeringuid\s+ei\s+vaja|no\s+(?:additional\s+)?investment(?:s)?\s+(?:needed|required)?)/i);
  if (noInvestmentStatement) {
    addFinding(
      result,
      snapshot,
      "no-investment-without-maintenance-evidence",
      "no_investment_without_maintenance_evidence",
      "No-investment claim lacks maintenance evidence",
      "The listing says that no investment is needed, but provides no independently verifiable material maintenance evidence.",
      "Request maintenance records before relying on the no-investment claim.",
      [
        evidenceForClaim(snapshot, "no-investment-without-maintenance-evidence", noInvestmentStatement.text, noInvestmentStatement.sourceClass),
        evidenceForAbsence(snapshot, "no-investment-without-maintenance-evidence", "Listing snapshot provides no material maintenance evidence."),
      ],
      {
        kind: "document_request",
        title: "Request maintenance records",
        instructions: "Ask for recent invoices and service records that support the no-investment claim.",
      },
    );
  }

  return result;
}
