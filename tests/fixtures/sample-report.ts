import type { AnalysisReport } from "@/domain/analysis";

export const sampleReport: AnalysisReport = {
  publicId: "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1",
  status: "complete",
  locale: "en",
  verdict: "worth_viewing",
  confidence: "moderate",
  vehicleFacts: [
    {
      key: "make_model",
      value: "Toyota Avensis",
      sourceId: "listing-source",
      verification: "unverified",
      confidence: 0.9,
    },
    {
      key: "year",
      value: "2016",
      sourceId: "listing-source",
      verification: "unverified",
      confidence: 0.9,
    },
    {
      key: "mileage",
      value: "184 000 km",
      sourceId: "listing-source",
      verification: "unverified",
      confidence: 0.8,
    },
  ],
  evidence: [
    {
      id: "seller-evidence",
      sourceId: "listing-source",
      sourceClass: "seller",
      sourceUrl: "https://www.auto24.ee/soidukid/123456",
      claim: "Hooldusraamat olemas ja auto on avariivaba.",
      applicability: "The listing describes this vehicle directly.",
      confidence: 0.72,
      verification: "unverified",
      capturedAt: "2026-09-19T08:00:00.000Z",
    },
  ],
  findings: [
    {
      id: "service-history",
      category: "history",
      severity: "important",
      state: "open",
      title: "Service history is claimed but not documented",
      explanation: "The listing mentions a service book, but no dated pages are visible.",
      nextAction: "Ask for photos of the service book and matching VIN page.",
      evidenceIds: ["seller-evidence"],
      origin: "deterministic",
    },
  ],
  actions: [
    {
      id: "ask-history",
      kind: "seller_question",
      title: "Service history",
      instructions: "When and where was the car last serviced?",
      status: "open",
      findingId: "service-history",
    },
    {
      id: "request-book",
      kind: "photo_request",
      title: "Service-book photos",
      instructions: "Please send dated service-book pages and the VIN page.",
      status: "open",
      findingId: "service-history",
    },
    {
      id: "inspect-cold-start",
      kind: "inspection_task",
      title: "Cold start",
      instructions: "Start the engine from cold and listen for rattles.",
      status: "open",
      findingId: "service-history",
    },
  ],
  sources: {
    "listing-source": {
      verification: "unverified",
      label: "Auto24 listing",
      url: "https://www.auto24.ee/soidukid/123456",
    },
    transportAdministration: {
      verification: "not_checked",
      label: "Estonian Transport Administration vehicle background check",
    },
  },
  warnings: [],
  updatedAt: "2026-09-19T08:05:00.000Z",
};
