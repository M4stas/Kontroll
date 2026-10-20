import { stableId } from "@/lib/stable-id";
import type { Action, Evidence, Finding, Locale, SourceClass } from "@/domain/analysis";
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
  return stableId(
    `${snapshot.marketplace}\n${snapshot.sourceId}\n${snapshot.sourceUrl}\n${snapshot.contentHash}\n${entity}\n${rule}\n${detail}`,
  );
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
    sourceClass: snapshot.marketplace === "fallback" ? "buyer" : "listing",
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
    sourceClass: snapshot.marketplace === "fallback" ? "buyer" : "listing",
    sourceUrl: snapshot.sourceUrl,
    claim: `Listing mileage fact: ${value.value} km.`,
    applicability: "Conflicting odometer values require independent verification.",
    confidence: 0.5,
    verification: "contradicted",
    capturedAt: snapshot.capturedAt,
  };
}

function evidenceForIdentityConflict(
  snapshot: ListingSnapshot,
  field: "vin" | "registrationPlate",
  value: NormalizedFieldValue,
): Evidence {
  const label = field === "vin" ? "VIN" : "registration plate";
  return {
    id: deterministicId(
      snapshot,
      "evidence",
      "missing-official-check-identity",
      `${field}:${value.value}:${value.sourceIds.join(",")}`,
    ),
    sourceId: value.sourceIds[0] ?? snapshot.sourceId,
    sourceClass: snapshot.marketplace === "fallback" ? "buyer" : "listing",
    sourceUrl: snapshot.sourceUrl,
    claim: `Conflicting ${label} fact: ${value.value}.`,
    applicability: "Conflicting listing identity values must be resolved before official checks.",
    confidence: 0.5,
    verification: "contradicted",
    capturedAt: snapshot.capturedAt,
  };
}

function evidenceForImageCoverage(snapshot: ListingSnapshot, referenceCount: number): Evidence {
  const claim = referenceCount === 0
    ? "Listing snapshot provides no image references; required inspection coverage is unverified."
    : `Listing snapshot includes ${referenceCount} image references, but their required inspection categories are unclassified.`;
  return {
    id: deterministicId(snapshot, "evidence", "missing-inspection-images", claim),
    sourceId: snapshot.sourceId,
    sourceClass: snapshot.marketplace === "fallback" ? "buyer" : "listing",
    sourceUrl: snapshot.sourceUrl,
    claim,
    applicability: "Image references do not establish a requested inspection category without classification.",
    confidence: 0.5,
    verification: "unverified",
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
  state: Finding["state"] = "open",
): void {
  const findingId = deterministicId(snapshot, "finding", rule);
  result.evidence.push(...evidence);
  result.findings.push({
    id: findingId,
    category,
    severity: "important",
    state,
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
  if (pattern.test(snapshot.description)) return { text: snapshot.description, sourceClass: snapshot.marketplace === "fallback" ? "buyer" : "listing" };
  return undefined;
}

function hasGearboxServiceDetail(snapshot: ListingSnapshot): boolean {
  const text = [snapshot.description, ...snapshot.claims.map((claim) => claim.text)].join(" ").toLocaleLowerCase("et");
  return /(?:käigukast|gearbox|transmission|dsg).{0,80}(?:hooldus|õli|oil|service|vahet|changed)|(?:hooldus|õli|oil|service|vahet|changed).{0,80}(?:käigukast|gearbox|transmission|dsg)/.test(text);
}

export function runBaselineChecks(vehicle: NormalizedVehicle, snapshot: ListingSnapshot, locale: Locale = "en"): BaselineResult {
  const result: BaselineResult = { evidence: [], findings: [], actions: [] };
  const majorMaintenance = listingStatement(snapshot, /suur\s*hooldus|major\s+(?:service|maintenance)/i);
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
      "confirmed",
    );
  }

  if (!vehicle.vin && !vehicle.registrationPlate) {
    const identityConflicts = vehicle.conflicts.filter((conflict) => (
      conflict.field === "vin" || conflict.field === "registrationPlate"
    ));
    const conflictLabels = identityConflicts.map((conflict) => (
      conflict.field === "vin" ? "VIN" : "registration plate"
    ));
    const identityEvidence = identityConflicts.flatMap((conflict) => (
      conflict.values.map((value) => evidenceForIdentityConflict(
        snapshot,
        conflict.field as "vin" | "registrationPlate",
        value,
      ))
    ));
    if (identityEvidence.length === 0) {
      identityEvidence.push(evidenceForAbsence(
        snapshot,
        "missing-official-check-identity",
        "Listing snapshot has no resolved usable VIN or Estonian registration plate for official checks.",
      ));
    }
    const explanation = conflictLabels.length > 0
      ? `The listing has conflicting ${conflictLabels.join(" and ")} values and no resolved usable VIN or Estonian registration plate for official checks.`
      : "The listing has no resolved usable VIN or Estonian registration plate for official checks.";
    addFinding(
      result,
      snapshot,
      "missing-official-check-identity",
      "missing_official_check_identity",
      "Official-check identity is missing",
      explanation,
      "Request a VIN or registration plate before relying on official history checks.",
      identityEvidence,
      {
        kind: "seller_question",
        title: "Request VIN or registration plate",
        instructions: "Ask the seller to provide either the VIN or the registration plate for official checks.",
      },
      identityConflicts.length > 0 ? "confirmed" : "open",
    );
  }

  const imageReferenceCount = snapshot.imageUrls.length + snapshot.screenshotRefs.length;
  const requiredCategories = ["underside", "engine_bay", "instrument_cluster", "service_document"];
  const classified = snapshot.inspectionImages?.filter((image) => snapshot.imageUrls.includes(image.url)) ?? [];
  const hasClassifiedCoverage = requiredCategories.every((category) => classified.some((image) => image.category === category))
    && new Set(classified.map((image) => image.url)).size >= 4;
  const imageExplanation = imageReferenceCount === 0
    ? "The listing snapshot provides no image references, so underside, engine-bay, instrument-cluster, and service-document coverage cannot be verified."
    : "The listing snapshot contains image references, but they are not classified as underside, engine-bay, instrument-cluster, or service-document evidence.";
  if (!hasClassifiedCoverage) addFinding(
    result,
    snapshot,
    "missing-inspection-images",
    "missing_inspection_images",
    "Inspection image coverage is unverified",
    imageExplanation,
    "Request classified underside, engine-bay, instrument-cluster, and service-document photos.",
    [evidenceForImageCoverage(snapshot, imageReferenceCount)],
    {
      kind: "photo_request",
      title: "Request inspection photos",
      instructions: "Request clear, labeled underside, engine-bay, instrument-cluster, and service-document photos.",
    },
  );

  const noInvestmentStatement = listingStatement(snapshot, /(?:ei\s+vaja\s+lisainvesteeringuid|lisainvesteeringuid\s+ei\s+vaja|no\s+(?:additional\s+)?investment(?:s)?\s+(?:needed|required)?)/i);
  if (noInvestmentStatement) {
    addFinding(
      result,
      snapshot,
      "no-investment-without-maintenance-evidence",
      "no_investment_without_maintenance_evidence",
      "No-investment claim lacks maintenance evidence",
      "The listing says that no investment is needed, but the available material has not independently verified that claim.",
      "Request maintenance records before relying on the no-investment claim.",
      [
        evidenceForClaim(snapshot, "no-investment-without-maintenance-evidence", noInvestmentStatement.text, noInvestmentStatement.sourceClass),
        evidenceForAbsence(snapshot, "no-investment-without-maintenance-evidence", "The analysis has no independently verified maintenance records for this claim."),
      ],
      {
        kind: "document_request",
        title: "Request maintenance records",
        instructions: "Ask for recent invoices and service records that support the no-investment claim.",
      },
    );
  }

  if (locale === "et") {
    const copy: Record<string, { title: string; explanation: string; nextAction: string; actionTitle: string; instructions: string }> = {
      unsupported_major_maintenance: {
        title: "Suure hoolduse väide vajab tõendit",
        explanation: "Kuulutuses väidetakse, et suur hooldus on tehtud, kuid see väide on kontrollimata.",
        nextAction: "Küsi väidetud tööde arveid või hooldusdokumente.",
        actionTitle: "Küsi suure hoolduse dokumente",
        instructions: "Palu müüjal saata arved või hooldusdokumendid, kus tehtud tööd on kirjas.",
      },
      missing_gearbox_service_detail: {
        title: "Automaatkäigukasti hoolduse andmed puuduvad",
        explanation: "Kuulutuses on automaatkäigukast, kuid selle hooldust pole kirjeldatud.",
        nextAction: "Küsi, millal käigukastiõli ja seotud hooldus viimati tehti.",
        actionTitle: "Küsi käigukasti hoolduse kohta",
        instructions: "Küsi käigukasti tüüpi, viimase hoolduse kuupäeva ja läbisõitu ning vastavat arvet.",
      },
      listing_mileage_disagreement: {
        title: "Kuulutuse läbisõiduandmed on vastuolus",
        explanation: "Kuulutuse eri andmed näitavad erinevat läbisõitu; tegelik näit vajab kontrolli.",
        nextAction: "Kontrolli odomeetrit ja läbisõidu ajalugu auto ülevaatusel.",
        actionTitle: "Kontrolli läbisõidu ajalugu",
        instructions: "Võrdle odomeetrit, hooldusdokumente ja ametlikku ajalugu vastuoluliste näitudega.",
      },
      missing_official_check_identity: {
        title: "Ametlikuks kontrolliks vajalik tunnus puudub",
        explanation: vehicle.conflicts.some((item) => item.field === "vin" || item.field === "registrationPlate")
          ? "Kuulutuse VIN või registreerimisnumber on vastuoluline; ametlikku ajalugu ei saa selle põhjal usaldusväärselt kontrollida."
          : "Kuulutuses pole kasutatavat VINi ega Eesti registreerimisnumbrit ametliku ajaloo kontrollimiseks.",
        nextAction: "Küsi VINi või registreerimisnumbrit enne ametliku ajaloo järelduste tegemist.",
        actionTitle: "Küsi VINi või registreerimisnumbrit",
        instructions: "Palu müüjal saata VIN või registreerimisnumber ametliku kontrolli jaoks.",
      },
      missing_inspection_images: {
        title: "Ülevaatuseks vajalikud fotod on kontrollimata",
        explanation: "Olemasolevad pildid ei tõenda põhjaaluse, mootoriruumi, näidikuploki ja hooldusdokumentide piisavat katvust.",
        nextAction: "Küsi selgelt märgistatud fotosid neist neljast vaatest.",
        actionTitle: "Küsi ülevaatuse fotosid",
        instructions: "Küsi selgeid fotosid põhjaalusest, mootoriruumist, näidikuplokist ja hooldusdokumentidest.",
      },
      no_investment_without_maintenance_evidence: {
        title: "Lisakuludeta auto väide vajab hooldustõendeid",
        explanation: "Kuulutus väidab, et lisakulutusi pole vaja, kuid olemasolev materjal ei kinnita seda sõltumatult.",
        nextAction: "Küsi hooldusdokumente enne sellele väitele tuginemist.",
        actionTitle: "Küsi hooldusdokumente",
        instructions: "Palu saata hiljutised arved ja hooldusdokumendid, mis väidet toetavad.",
      },
    };
    for (const finding of result.findings) {
      const localized = copy[finding.category];
      if (!localized) continue;
      finding.title = localized.title;
      finding.explanation = localized.explanation;
      finding.nextAction = localized.nextAction;
      for (const action of result.actions.filter((item) => item.findingId === finding.id)) {
        action.title = localized.actionTitle;
        action.instructions = localized.instructions;
      }
    }
  }
  return result;
}
