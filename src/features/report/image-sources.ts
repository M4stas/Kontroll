import { z } from "zod";

export interface ReportImageSource { storageKey?: string; contentHash?: string }
const imageSchema = z.object({ evidenceId: z.uuid(), status: z.string(), storageKey: z.string().optional(), contentHash: z.string().optional() });
const snapshotSchema = z.object({ analysisId: z.string(), imageManifest: z.object({images: z.array(imageSchema)}) });
/** Resolve stored citations only. Neither clients nor models supply storage paths. */
export function reviewImageSources(analysisId: string, rows: Array<Record<string, unknown>>): Map<string, ReportImageSource> {
 const sources = new Map<string, ReportImageSource>();
 for (const row of rows) {
  const parsed = snapshotSchema.safeParse(row.snapshot);
  if (row.analysis_id !== analysisId || !parsed.success || parsed.data.analysisId !== analysisId) continue;
  for (const image of parsed.data.imageManifest.images) {
   if (sources.has(image.evidenceId)) continue;
   if (image.storageKey && (!image.storageKey.startsWith(`${analysisId}/`) || image.storageKey.includes("..") || image.storageKey.includes("\\"))) continue;
   sources.set(image.evidenceId, image.status === "accepted" && image.storageKey ? {storageKey:image.storageKey,...(image.contentHash ? {contentHash:image.contentHash}: {})} : {});
  }
 }
 return sources;
}
