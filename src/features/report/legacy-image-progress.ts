import { z } from "zod";
import type { ReviewProgress } from "@/domain/analysis";

const snapshotSchema = z.object({
 analysisId: z.string(),
 imageManifest: z.object({images: z.array(z.object({
  evidenceId: z.string().min(1),
  selected: z.boolean(),
  status: z.enum(["accepted", "skipped", "rejected", "unavailable"]),
 }))}),
});

/** Hydrate old aggregate-only progress from the newest owned immutable manifest. */
export function legacyImageProgress(
 analysisId: string,
 review: ReviewProgress,
 rows: Array<Record<string, unknown>>,
 committedImageEvidenceIds: readonly string[] = [],
): ReviewProgress {
 if (review.images.items !== undefined) return review;
 const committed = new Set(committedImageEvidenceIds);
 for (const row of rows) {
  if (row.analysis_id !== analysisId) continue;
  const parsed = snapshotSchema.safeParse(row.snapshot);
  if (!parsed.success || parsed.data.analysisId !== analysisId) continue;
  const items: NonNullable<ReviewProgress["images"]["items"]> = parsed.data.imageManifest.images.map(image => ({
   evidenceId: image.evidenceId,
   state: image.selected && (review.state === "complete" || committed.has(image.evidenceId)) ? "complete"
    : image.status === "unavailable" || image.status === "rejected" ? "unavailable"
    : !image.selected || image.status === "skipped" ? "skipped" : "pending",
  }));
  return {...review,images:{...review.images,items}};
 }
 return review;
}
