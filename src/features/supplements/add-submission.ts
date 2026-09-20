import { randomUUID } from "node:crypto";
import { affectedStages, type Submission } from "@/analysis/affected-stages";
import { ANALYSIS_STAGES, type AnalysisStage } from "@/analysis/stages";
import type {
  AcceptedSubmissionGroup,
  JobsRepository,
  SubmissionWrite,
} from "@/server/repositories/jobs";

export interface SupplementItem extends SubmissionWrite {
  identityCorrection?: "vin" | "registrationPlate";
}

export interface AddSubmissionInput {
  analysisId: string;
  idempotencyKey?: string;
  items?: SupplementItem[];
  kind?: SupplementItem["kind"];
  providedBy?: SupplementItem["providedBy"];
  textContent?: string;
  storageKey?: string;
  mimeType?: string;
  identityCorrection?: SupplementItem["identityCorrection"];
}

interface AddSubmissionDependencies {
  jobs: Pick<JobsRepository, "enqueueMany">;
}

function inputItems(input: AddSubmissionInput): SupplementItem[] {
  if (input.items) return input.items;
  if (!input.kind) throw new Error("Submission kind is required");
  return [{
    kind: input.kind,
    providedBy: input.providedBy ?? "seller",
    ...(input.textContent !== undefined ? { textContent: input.textContent } : {}),
    ...(input.storageKey !== undefined ? { storageKey: input.storageKey } : {}),
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    ...(input.identityCorrection !== undefined ? { identityCorrection: input.identityCorrection } : {}),
  }];
}

function validate(items: SupplementItem[]): void {
  if (items.length === 0) throw new Error("At least one seller submission is required");
  const files = items.filter((item) => item.storageKey);
  if (files.length > 8) throw new Error("A submission can contain at most eight files");
  for (const item of items) {
    if (item.textContent && item.textContent.length > 10_000) {
      throw new Error("Seller answer text cannot exceed 10,000 characters");
    }
    if (!item.textContent && !item.storageKey) {
      throw new Error("Each submission must contain text or a file");
    }
  }
}

function stagesFor(items: SupplementItem[]): AnalysisStage[] {
  const selected = new Set<AnalysisStage>();
  for (const item of items) {
    const submission: Submission = {
      kind: item.kind,
      ...(item.identityCorrection ? { identityCorrection: item.identityCorrection } : {}),
    };
    for (const stage of affectedStages(submission)) selected.add(stage);
  }
  return ANALYSIS_STAGES.filter((stage) => selected.has(stage));
}

export async function addSubmission(
  input: AddSubmissionInput,
  dependencies: AddSubmissionDependencies,
): Promise<AcceptedSubmissionGroup> {
  const items = inputItems(input);
  validate(items);
  const queuedStages = stagesFor(items);
  const accepted = await dependencies.jobs.enqueueMany({
    analysisId: input.analysisId,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    submissions: items.map((item) => ({
      kind: item.kind,
      providedBy: item.providedBy,
      ...(item.textContent !== undefined ? { textContent: item.textContent } : {}),
      ...(item.storageKey !== undefined ? { storageKey: item.storageKey } : {}),
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
      ...(item.identityCorrection !== undefined ? { identityCorrection: item.identityCorrection } : {}),
    })),
    stages: queuedStages,
  });

  return accepted;
}
