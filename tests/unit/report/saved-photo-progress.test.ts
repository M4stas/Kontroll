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

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const newId = '33333333-3333-4333-8333-333333333333';
const parentReview: ReviewProgress = {...saved, images: {...saved.images, supplied: 1, selected: 1, complete: 1, items: [{evidenceId: parentId, state: 'complete'}]}};
const childReview: ReviewProgress = {...current, images: {...current.images, supplied: 2, selected: 2, items: [{evidenceId: childId, state: 'running'}, {evidenceId: newId, state: 'pending'}]}};
const image = (evidenceId: string, storageKey = 'analysis/photo.jpg', contentHash = 'unchanged') => ({evidenceId, storageKey, contentHash, status: 'accepted'});
const manifest = (runId: string, images: ReturnType<typeof image>[], analysisId = 'analysis') => ({analysis_id: analysisId, run_id: runId, snapshot: {analysisId, imageManifest: {images}}});
const identity = (rows = [manifest('parent', [image(parentId)]), manifest('child', [image(childId), image(newId, 'analysis/new.jpg', 'new')])]) => ({analysisId: 'analysis', currentRunId: 'child', previousRunId: 'parent', rows});

it('retains a saved photo after a seller rerun remaps its evidence ID', () => {
  const result = savedPhotoProgress(childReview, parentReview, identity())!;
  expect(result.images.items).toEqual([{evidenceId: childId, state: 'complete'}, {evidenceId: newId, state: 'pending'}]);
  expect(result.images).toMatchObject({supplied: 2, selected: 2, complete: 1});
  expect(result).toMatchObject({state: 'running', text: 'pending', final: 'pending'});
  expect(childReview.images.items?.[0]?.state).toBe('running');
});

it.each([
  ['changed content', [manifest('parent', [image(parentId)]), manifest('child', [image(childId, 'analysis/photo.jpg', 'changed')])]],
  ['different storage', [manifest('parent', [image(parentId)]), manifest('child', [image(childId, 'analysis/different.jpg')])]],
  ['missing hash', [manifest('parent', [image(parentId)]), manifest('child', [image(childId, 'analysis/photo.jpg', '')])]],
  ['foreign analysis', [manifest('parent', [image(parentId)]), manifest('child', [image(childId)], 'other')]],
  ['foreign snapshot', [manifest('parent', [image(parentId)]), {...manifest('child', [image(childId)]), snapshot: {analysisId: 'other', imageManifest: {images: [image(childId)]}}}]],
  ['unrelated run', [manifest('parent', [image(parentId)]), manifest('unrelated', [image(childId)])]],
  ['unowned storage', [manifest('parent', [image(parentId, 'other/photo.jpg')]), manifest('child', [image(childId, 'other/photo.jpg')])]],
])('does not retain remapped completion for %s', (_name, rows) => {
  expect(savedPhotoProgress(childReview, parentReview, identity(rows))).toEqual(childReview);
});

it.each(['unavailable', 'skipped', 'complete'] as const)('preserves current %s state despite a saved immutable match', state => {
  const review: ReviewProgress = {...childReview, images: {...childReview.images, complete: state === 'complete' ? 1 : 0, items: [{evidenceId: childId, state}, {evidenceId: newId, state: 'pending'}]}};
  expect(savedPhotoProgress(review, parentReview, identity())).toEqual(review);
});
