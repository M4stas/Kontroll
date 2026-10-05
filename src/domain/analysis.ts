export type Verdict = "worth_viewing" | "proceed_cautiously" | "likely_skip";
export type ConfidenceBand = "low" | "moderate" | "high";
export type FindingSeverity = "critical" | "important" | "context";
export type FindingState = "open" | "confirmed" | "cleared";
export type VerificationState =
  | "unverified"
  | "corroborated"
  | "official"
  | "contradicted"
  | "not_checked";
export type EvidenceRelation = "supports" | "contradicts";
export type SourceClass =
  | "official_registry"
  | "manufacturer"
  | "independent"
  | "forum"
  | "listing"
  | "seller"
  | "buyer";
export type AnalysisStatus = "queued" | "running" | "partial" | "complete" | "failed";
export type Locale = "et" | "en";
export type ActionKind =
  | "seller_question"
  | "photo_request"
  | "document_request"
  | "workshop_recommendation"
  | "inspection_task";
export type ActionStatus = "open" | "complete";
export type FindingOrigin = "deterministic" | "agent";

export interface ConfidenceInput {
  identity: number;
  coverage: number;
  agreement: number;
  freshness: number;
}

export interface Evidence {
  id: string;
  sourceId: string;
  sourceClass: SourceClass;
  sourceUrl?: string;
  imageUrl?: string;
  claim: string;
  applicability: string;
  confidence: number;
  verification: VerificationState;
  capturedAt: string;
}

export interface VehicleFact {
  key: string;
  value: string;
  normalizedValue?: string;
  sourceId: string;
  verification: VerificationState;
  confidence: number;
}

export interface Finding {
  id: string;
  category: string;
  severity: FindingSeverity;
  state: FindingState;
  title: string;
  explanation: string;
  nextAction: string;
  evidenceIds: string[];
  origin?: FindingOrigin;
}

export interface Action {
  id: string;
  kind: ActionKind;
  title: string;
  instructions: string;
  status: ActionStatus;
  findingId?: string;
}

export interface SourceSummary {
  verification: VerificationState;
  label?: string;
  url?: string;
}

export interface ReviewProgress {
  state: "pending" | "running" | "incomplete" | "disabled" | "complete";
  text: "pending" | "complete" | "unavailable";
  images: { supplied:number; selected:number; complete:number; unavailable:number; skipped:number; items?: { evidenceId: string; state: "pending" | "running" | "complete" | "unavailable" | "skipped" }[] };
  final: "pending" | "complete" | "unavailable";
}

export interface AnalysisReport {
  activity?: { state: "queued" | "running" | "stale" | "stopped"; leaseExpiresAt?: string };
  review?: ReviewProgress;
  publicId: string;
  status: AnalysisStatus;
  locale: Locale;
  verdict: Verdict | null;
  confidence: ConfidenceBand | null;
  vehicleFacts: VehicleFact[];
  evidence: Evidence[];
  findings: Finding[];
  actions: Action[];
  sources: Record<string, SourceSummary>;
  warnings: string[];
  updatedAt: string;
}
