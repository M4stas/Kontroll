import type { ReviewProgress } from '@/domain/analysis';
import { reviewImageSources, type ReportImageSource } from './image-sources';

interface PhotoLineage {
  analysisId: string;
  currentRunId: string;
  previousRunId: string;
  rows: Array<Record<string, unknown>>;
}

function immutableIdentity(source: ReportImageSource | undefined): string | undefined {
  return source?.storageKey && source.contentHash
    ? JSON.stringify([source.storageKey, source.contentHash])
    : undefined;
}

/** Keep earlier saved photo reviews visible while new information is reviewed. */
export function savedPhotoProgress(
  current: ReviewProgress | undefined,
  previous: ReviewProgress | undefined,
  lineage?: PhotoLineage,
): ReviewProgress | undefined {
  if (!previous) return current;
  if (!current) return {...previous, state: 'pending', text: 'pending', final: 'pending'};
  if (current.images.items === undefined && current.images.supplied === 0) {
    return {...current, images: previous.images};
  }
  if (!current.images.items || !previous.images.items) return current;
  const reviewed = new Set(previous.images.items.filter(photo => photo.state === 'complete').map(photo => photo.evidenceId));
  // Citation IDs can change on a baseline rerun; only owned immutable bytes carry progress forward.
  const previousSources = lineage ? reviewImageSources(lineage.analysisId, lineage.rows.filter(row => row.run_id === lineage.previousRunId)) : new Map<string, ReportImageSource>();
  const currentSources = lineage ? reviewImageSources(lineage.analysisId, lineage.rows.filter(row => row.run_id === lineage.currentRunId)) : new Map<string, ReportImageSource>();
  const reviewedIdentities = new Set([...reviewed].flatMap(id => {
    const identity = immutableIdentity(previousSources.get(id));
    return identity ? [identity] : [];
  }));
  const items = current.images.items.map(photo =>
    (photo.state === 'pending' || photo.state === 'running') && (reviewed.has(photo.evidenceId)
      || reviewedIdentities.has(immutableIdentity(currentSources.get(photo.evidenceId)) ?? ''))
      ? {...photo, state: 'complete' as const}
      : photo,
  );
  return {...current, images: {...current.images, items, complete: items.filter(photo => photo.state === 'complete').length}};
}

/** Fold earlier runs oldest first, so a stalled middle run does not hide older completions. */
export function foldSavedPhotoProgress(
  runs: Array<{runId: string; review: ReviewProgress | undefined}>,
  analysisId: string,
  rows: Array<Record<string, unknown>>,
): {runId: string; review: ReviewProgress | undefined} | undefined {
  let folded: {runId: string; review: ReviewProgress | undefined} | undefined;
  for (const run of runs) {
    folded = {runId: run.runId, review: folded
      ? savedPhotoProgress(run.review, folded.review, {analysisId, currentRunId: run.runId, previousRunId: folded.runId, rows})
      : run.review};
  }
  return folded;
}
