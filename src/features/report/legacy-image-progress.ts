import { z } from "zod";
import type { ReviewProgress } from "@/domain/analysis";
import { withManifestItems } from "@/analysis/review-progress";

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
  return withManifestItems(review, parsed.data.imageManifest.images, committed);
 }
 return review;
}
