import { describe, expect, it } from 'vitest';
import {
  carryForwardReviewedImages, completedReviewProgress, finalizeProgress, initialReviewProgress, isReviewComplete,
  manifestImageState, markImage, markIncomplete, markPassComplete, markUnavailable, recountUnavailable,
  restartedProgress, unavailableReviewProgress, withManifestItems, type ProgressManifest,
} from '@/analysis/review-progress';

const manifest: ProgressManifest = {
  counts: { supplied: 4, selected: 3, skipped: 1, rejected: 1, unavailable: 0 },
  images: [
    { evidenceId: 'a', selected: true, status: 'accepted' },
    { evidenceId: 'b', selected: true, status: 'accepted' },
    { evidenceId: 'c', selected: true, status: 'rejected' },
    { evidenceId: 'd', selected: false, status: 'skipped' },
  ],
};
const states = (progress: ReturnType<typeof initialReviewProgress>) => progress.images.items?.map(item => item.state);

describe('review progress', () => {
  it('maps manifest status to image state', () => {
    expect(manifest.images.map(image => manifestImageState(image))).toEqual(['pending', 'pending', 'unavailable', 'skipped']);
    expect(manifest.images.map(image => manifestImageState(image, true))).toEqual(['complete', 'complete', 'complete', 'skipped']);
    expect(manifestImageState({ evidenceId: 'x', selected: false, status: 'unavailable' }, true)).toBe('unavailable');
  });

  it('starts from manifest counts', () => {
    const progress = initialReviewProgress(manifest, false);
    expect(progress).toMatchObject({ state: 'running', text: 'pending', final: 'pending', images: { supplied: 4, selected: 3, complete: 0, unavailable: 1, skipped: 1 } });
    expect(states(progress)).toEqual(['pending', 'pending', 'unavailable', 'skipped']);
    expect(initialReviewProgress(manifest, true).state).toBe('disabled');
    expect(unavailableReviewProgress(manifest)).toMatchObject({ state: 'incomplete', text: 'unavailable', final: 'pending', images: { complete: 0, unavailable: 1 } });
  });

  it('builds published progress', () => {
    const progress = completedReviewProgress(manifest, 2);
    expect(progress).toMatchObject({ state: 'complete', text: 'complete', final: 'complete', images: { complete: 2, unavailable: 1 } });
    expect(states(progress)).toEqual(['complete', 'complete', 'complete', 'skipped']);
  });

  it('marks images and recounts without mutating the input', () => {
    const start = initialReviewProgress(manifest, false);
    const running = markImage(start, 'a', 'running');
    expect(states(running)?.[0]).toBe('running');
    expect(states(start)?.[0]).toBe('pending');
    const done = markImage(running, 'a', 'complete');
    expect(done.images.complete).toBe(1);
    const failed = markUnavailable(done, 'image', 'b');
    expect(failed).toMatchObject({ state: 'incomplete', images: { complete: 1, unavailable: 2 } });
    expect(markUnavailable(start, 'text')).toMatchObject({ state: 'incomplete', text: 'unavailable' });
  });

  it('applies pass and run transitions', () => {
    const start = initialReviewProgress(manifest, false);
    expect(markPassComplete(start, 'text').text).toBe('complete');
    expect(markIncomplete(start).state).toBe('incomplete');
    expect(finalizeProgress(start)).toMatchObject({ state: 'complete', final: 'complete' });
    expect(recountUnavailable({ ...start, images: { ...start.images, unavailable: 9 } }).images.unavailable).toBe(1);
    expect(restartedProgress(finalizeProgress(start))).toMatchObject({ state: 'pending', text: 'pending', final: 'pending' });
  });

  it('carries earlier reviews forward and hydrates legacy items', () => {
    const start = markImage(initialReviewProgress(manifest, false), 'b', 'running');
    const carried = carryForwardReviewedImages(start, id => id !== 'd');
    expect(states(carried)).toEqual(['complete', 'complete', 'unavailable', 'skipped']);
    expect(carried.images.complete).toBe(2);
    const legacy = { ...start, images: { ...start.images, items: undefined } };
    expect(states(withManifestItems(legacy, manifest.images, new Set(['a'])))).toEqual(['complete', 'pending', 'unavailable', 'skipped']);
  });

  it('is complete only when every pass and selected image finished', () => {
    const complete = { ...completedReviewProgress(manifest, 3), images: { ...completedReviewProgress(manifest, 3).images, unavailable: 0 } };
    expect(isReviewComplete(complete)).toBe(true);
    expect(isReviewComplete(completedReviewProgress(manifest, 3))).toBe(false);
    expect(isReviewComplete(undefined)).toBe(false);
  });
});
