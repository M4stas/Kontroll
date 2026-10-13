import { expect, it } from 'vitest';
import type { ReviewProgress } from '@/domain/analysis';
import { savedPhotoProgress } from '@/features/report/saved-photo-progress';

const saved: ReviewProgress = {
  state: 'complete', text: 'complete', final: 'complete',
  images: {supplied: 2, selected: 2, complete: 2, unavailable: 0, skipped: 0,
    items: [{evidenceId: 'old-1', state: 'complete'}, {evidenceId: 'old-2', state: 'complete'}]},
};
const current: ReviewProgress = {
  state: 'running', text: 'pending', final: 'pending',
  images: {supplied: 3, selected: 3, complete: 0, unavailable: 0, skipped: 0,
    items: [{evidenceId: 'old-1', state: 'pending'}, {evidenceId: 'old-2', state: 'running'}, {evidenceId: 'new', state: 'pending'}]},
};
it('keeps saved photo inventory visible before a seller update publishes progress', () => {
  expect(savedPhotoProgress(undefined, saved)).toEqual({...saved, state: 'pending', text: 'pending', final: 'pending'});
  expect(saved.state).toBe('complete');
});
it('retains matching completed photos while a child run reviews new information', () => {
  const result = savedPhotoProgress(current, saved)!;
  expect(result.images.items).toEqual([{evidenceId: 'old-1', state: 'complete'}, {evidenceId: 'old-2', state: 'complete'}, {evidenceId: 'new', state: 'pending'}]);
  expect(result.images).toMatchObject({supplied: 3, selected: 3, complete: 2, unavailable: 0, skipped: 0});
  expect(result).toMatchObject({state: 'running', text: 'pending', final: 'pending'});
  expect(current.images.complete).toBe(0);
  expect(current.images.items?.[0]?.state).toBe('pending');
});
it('preserves current unavailable, skipped and completed photo states', () => {
  const failed: ReviewProgress = {...current, state: 'incomplete', text: 'unavailable', final: 'unavailable',
    images: {...current.images, selected: 2, complete: 1, unavailable: 1, skipped: 1,
      items: [{evidenceId: 'old-1', state: 'unavailable'}, {evidenceId: 'old-2', state: 'skipped'}, {evidenceId: 'new', state: 'complete'}]}};
  expect(savedPhotoProgress(failed, saved)).toEqual(failed);
});
it('keeps the existing PDF reuse text and final states', () => {
  const pdf: ReviewProgress = {...saved, state: 'pending', final: 'pending'};
  expect(savedPhotoProgress(pdf, saved)).toEqual(pdf);
});
it('uses saved inventory when current progress has no photo inventory yet', () => {
  const empty: ReviewProgress = {...current, images: {supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0}};
  expect(savedPhotoProgress(empty, saved)).toEqual({...empty, images: saved.images});
});
it('does not replace an explicit current empty inventory', () => {
  const empty: ReviewProgress = {...current, images: {supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0, items: []}};
  expect(savedPhotoProgress(empty, saved)).toEqual(empty);
});
it('does not claim completion without a matching saved completed photo', () => {
  const previous: ReviewProgress = {...saved, images: {...saved.images, complete: 0, items: [{evidenceId: 'old-1', state: 'pending'}, {evidenceId: 'other', state: 'complete'}]}};
  expect(savedPhotoProgress(current, previous)).toEqual(current);
  expect(savedPhotoProgress(current, undefined)).toBe(current);
  expect(savedPhotoProgress(undefined, undefined)).toBeUndefined();
});
