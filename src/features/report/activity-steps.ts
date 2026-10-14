import type { AnalysisReport } from '@/domain/analysis';
import { activityState } from './activity-state';

type ActivityState = ReturnType<typeof activityState>['state'];

export type ActivityProgress = Omit<ReturnType<typeof activityState>, 'state'> & {
  state: ActivityState | 'checking';
};

export type ActivityStepKey = 'readListing' | 'reviewPhotos' | 'writeReview';
export type ActivityStepState = 'waiting' | 'active' | 'done' | 'warning';

type ActivityStepDetailKey =
  | 'listingChecked'
  | 'unavailable'
  | 'readingListing'
  | 'waitingToReadListing'
  | 'noSuppliedPhotos'
  | 'photosReviewed'
  | 'waitingForPhotos'
  | 'readyToRead'
  | 'writingReview'
  | 'notStarted';

export interface ActivityStep {
  key: ActivityStepKey;
  state: ActivityStepState;
  fill: number;
  detailKey: ActivityStepDetailKey;
  detailValues?: { complete: number; supplied: number };
}

export function activitySteps(report: AnalysisReport, progress: ActivityProgress): ActivityStep[] {
  const review = report.review;
  const hasPhotoProgress = !!review && (review.state !== 'pending' || review.images.complete > 0);
  const done = [
    review?.text === 'complete',
    hasPhotoProgress && review.state !== 'disabled' && review.text === 'complete' &&
      review.images.complete === review.images.selected && review.images.unavailable === 0,
    review?.final === 'complete',
  ];
  const current = done.findIndex((isDone) => !isDone);
  const running = progress.state === 'running';
  const keys: ActivityStepKey[] = ['readListing', 'reviewPhotos', 'writeReview'];

  const states = keys.map((_, index): ActivityStepState => {
    if (done[index]) return 'done';
    if (index !== current) return 'waiting';
    if (progress.state === 'stopped' || progress.state === 'stale') return 'warning';
    return running ? 'active' : 'waiting';
  });

  const details: Array<{ key: ActivityStepDetailKey; values?: ActivityStep['detailValues'] }> = [
    {
      key: review?.text === 'complete'
        ? 'listingChecked'
        : review?.text === 'unavailable'
          ? 'unavailable'
          : current === 0 && running
            ? 'readingListing'
            : 'waitingToReadListing',
    },
    !hasPhotoProgress
      ? { key: 'waitingForPhotos' }
      : review.images.supplied === 0
        ? { key: 'noSuppliedPhotos' }
        : {
          key: 'photosReviewed',
          values: { complete: review.images.complete, supplied: review.images.supplied },
        },
    {
      key: review?.final === 'complete'
        ? 'readyToRead'
        : review?.final === 'unavailable'
          ? 'unavailable'
          : current === 2 && running
            ? 'writingReview'
            : 'notStarted',
    },
  ];

  const measuredFills: Array<number | undefined> = [
    review?.text === 'complete' ? 1 : undefined,
    review && review.images.selected > 0
      ? Math.min(1, Math.max(0, review.images.complete / review.images.selected))
      : undefined,
    review?.final === 'complete' ? 1 : undefined,
  ];

  return keys.map((key, index) => {
    const state = states[index]!;
    const measuredFill = measuredFills[index];
    const detail = details[index]!;
    return {
      key,
      state,
      fill: measuredFill ?? (state === 'done' ? 1 : state === 'active' ? 0.5 : 0),
      detailKey: detail.key,
      ...(detail.values ? { detailValues: detail.values } : {}),
    };
  });
}

export function canOpenReport(progress: ActivityProgress): boolean {
  return progress.state === 'complete' || progress.state === 'stopped' || progress.state === 'stale';
}
