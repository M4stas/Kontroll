import type { ReviewProgress } from "@/domain/analysis";

/** Shared by server and client code; keep this module free of server-only imports. */
export type ReviewImageState = NonNullable<ReviewProgress["images"]["items"]>[number]["state"];

export interface ProgressManifestImage {
  evidenceId: string;
  selected: boolean;
  status: "accepted" | "skipped" | "rejected" | "unavailable";
}

export interface ProgressManifest {
  counts: { supplied: number; selected: number; skipped: number; rejected: number; unavailable: number };
  images: readonly ProgressManifestImage[];
}

/** A selected image that was reviewed is complete; otherwise its manifest status decides. */
export function manifestImageState(image: ProgressManifestImage, reviewed = false): ReviewImageState {
  if (image.selected && reviewed) return "complete";
  if (image.status === "unavailable" || image.status === "rejected") return "unavailable";
  return !image.selected || image.status === "skipped" ? "skipped" : "pending";
}

function countImages(progress: ReviewProgress, state: ReviewImageState): number {
  return progress.images.items?.filter(item => item.state === state).length ?? 0;
}

function manifestImages(manifest: ProgressManifest, complete: number, reviewed: boolean): ReviewProgress["images"] {
  return {
    supplied: manifest.counts.supplied,
    selected: manifest.counts.selected,
    complete,
    unavailable: manifest.counts.unavailable + manifest.counts.rejected,
    skipped: manifest.counts.skipped,
    items: manifest.images.map(image => ({ evidenceId: image.evidenceId, state: manifestImageState(image, reviewed) })),
  };
}

export function initialReviewProgress(manifest: ProgressManifest, disabled: boolean): ReviewProgress {
  return { state: disabled ? "disabled" : "running", text: "pending", images: manifestImages(manifest, 0, false), final: "pending" };
}

/** Fallback when the run snapshot cannot be pinned; baseline results stay intact. */
export function unavailableReviewProgress(manifest: ProgressManifest): ReviewProgress {
  return { state: "incomplete", text: "unavailable", images: manifestImages(manifest, 0, false), final: "pending" };
}

/** Progress published with a committed final assessment. */
export function completedReviewProgress(manifest: ProgressManifest, completeImages: number): ReviewProgress {
  return { state: "complete", text: "complete", images: manifestImages(manifest, completeImages, true), final: "complete" };
}

/** Sets one image's state and recounts the counter that state feeds. */
export function markImage(progress: ReviewProgress, evidenceId: string | undefined, state: ReviewImageState): ReviewProgress {
  const items = progress.images.items?.map(item => item.evidenceId === evidenceId ? { ...item, state } : item);
  const next = { ...progress, images: { ...progress.images, items } };
  if (state === "complete") next.images.complete = countImages(next, "complete");
  if (state === "unavailable") next.images.unavailable = countImages(next, "unavailable");
  return next;
}

export function markPassComplete(progress: ReviewProgress, pass: "text"): ReviewProgress {
  return { ...progress, [pass]: "complete" };
}

/** A pass or image could not be reviewed, so the run cannot complete. */
export function markUnavailable(progress: ReviewProgress, pass: "text" | "image" | "final", evidenceId?: string): ReviewProgress {
  const next = pass === "image" ? markImage(progress, evidenceId, "unavailable") : { ...progress, [pass]: "unavailable" as const };
  return { ...next, state: "incomplete" };
}

export function markIncomplete(progress: ReviewProgress): ReviewProgress {
  return { ...progress, state: "incomplete" };
}

export function recountUnavailable(progress: ReviewProgress): ReviewProgress {
  return { ...progress, images: { ...progress.images, unavailable: countImages(progress, "unavailable") } };
}

export function finalizeProgress(progress: ReviewProgress): ReviewProgress {
  return { ...progress, state: "complete", final: "complete" };
}

/** Earlier progress shown while a new run has not reported yet. */
export function restartedProgress(previous: ReviewProgress): ReviewProgress {
  return { ...previous, state: "pending", text: "pending", final: "pending" };
}

/** Marks pending or running images complete when an earlier run already reviewed them. */
export function carryForwardReviewedImages(progress: ReviewProgress, reviewed: (evidenceId: string) => boolean): ReviewProgress {
  const items = (progress.images.items ?? []).map(item =>
    (item.state === "pending" || item.state === "running") && reviewed(item.evidenceId) ? { ...item, state: "complete" as const } : item,
  );
  return { ...progress, images: { ...progress.images, items, complete: items.filter(item => item.state === "complete").length } };
}

/** Rebuilds per-image states for old progress that stored only aggregate counts. */
export function withManifestItems(progress: ReviewProgress, images: readonly ProgressManifestImage[], committed: ReadonlySet<string>): ReviewProgress {
  const items = images.map(image => ({
    evidenceId: image.evidenceId,
    state: manifestImageState(image, progress.state === "complete" || committed.has(image.evidenceId)),
  }));
  return { ...progress, images: { ...progress.images, items } };
}

export function isReviewComplete(review: ReviewProgress | undefined): boolean {
  return review?.state === "complete" && review.text === "complete" && review.final === "complete"
    && review.images.complete === review.images.selected && review.images.unavailable === 0;
}
