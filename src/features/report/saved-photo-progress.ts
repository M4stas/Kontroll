import type { ReviewProgress } from '@/domain/analysis';

/** Keep earlier saved photo reviews visible while new information is reviewed. */
export function savedPhotoProgress(
  current: ReviewProgress | undefined,
  previous: ReviewProgress | undefined,
): ReviewProgress | undefined {
  if (!previous) return current;
  if (!current) return {...previous, state: 'pending', text: 'pending', final: 'pending'};
  if (current.images.items === undefined && current.images.supplied === 0) {
    return {...current, images: previous.images};
  }
  if (!current.images.items || !previous.images.items) return current;
  const reviewed = new Set(previous.images.items.filter(photo => photo.state === 'complete').map(photo => photo.evidenceId));
  const items = current.images.items.map(photo =>
    (photo.state === 'pending' || photo.state === 'running') && reviewed.has(photo.evidenceId)
      ? {...photo, state: 'complete' as const}
      : photo,
  );
  return {...current, images: {...current.images, items, complete: items.filter(photo => photo.state === 'complete').length}};
}
