import { expect, it } from 'vitest';
import { activitySteps, canOpenReport } from '@/features/report/activity-steps';
import { activityState } from '@/features/report/activity-state';
import type { AnalysisReport } from '@/domain/analysis';
import { sampleReport } from '../../fixtures/sample-report';

const successful: AnalysisReport = {
  ...sampleReport,
  status: 'complete',
  review: {
    state: 'complete',
    text: 'complete',
    final: 'complete',
    images: { supplied: 1, selected: 1, complete: 1, unavailable: 0, skipped: 0 },
  },
};

const incomplete: AnalysisReport = {
  ...successful,
  status: 'running',
  review: {
    state: 'incomplete',
    text: 'complete',
    final: 'pending',
    images: { supplied: 3, selected: 3, complete: 1, unavailable: 1, skipped: 0 },
  },
};

const now = Date.parse('2026-10-05T12:00:00Z');

function steps(report: AnalysisReport, state = activityState(report, now, true)) {
  return activitySteps(report, state);
}

function stepFor(report: AnalysisReport, key: 'readListing' | 'reviewPhotos' | 'writeReview') {
  return steps(report).find((step) => step.key === key);
}

it('does not mark a pending empty inventory as reviewed', () => {
  const report: AnalysisReport = {
    ...successful,
    status: 'queued',
    review: {
      state: 'pending',
      text: 'pending',
      final: 'pending',
      images: { supplied: 0, selected: 0, complete: 0, unavailable: 0, skipped: 0 },
    },
  };

  expect(stepFor(report, 'reviewPhotos')).toMatchObject({
    key: 'reviewPhotos',
    state: 'waiting',
    fill: 0,
    detailKey: 'waitingForPhotos',
  });
});

it('keeps the photo step running while an incomplete review has a live worker lease', () => {
  const report: AnalysisReport = {
    ...incomplete,
    activity: { state: 'running', leaseExpiresAt: '2026-10-05T12:00:05Z' },
  };

  expect(stepFor(report, 'reviewPhotos')).toEqual({
    key: 'reviewPhotos',
    state: 'active',
    fill: 1 / 3,
    detailKey: 'photosReviewed',
    detailValues: { complete: 1, supplied: 3 },
  });
});

it('shows an incomplete queued retry as queued when worker activity is queued', () => {
  const report: AnalysisReport = {
    ...incomplete,
    status: 'queued',
    activity: { state: 'queued' },
  };

  expect(steps(report).map(({ key, state }) => [key, state])).toEqual([
    ['readListing', 'done'],
    ['reviewPhotos', 'waiting'],
    ['writeReview', 'waiting'],
  ]);
});

it('keeps saved photo progress visible while a PDF final assessment is queued', () => {
  const report: AnalysisReport = {
    ...successful,
    status: 'queued',
    activity: { state: 'queued' },
    review: { ...successful.review!, state: 'pending', final: 'pending' },
  };

  expect(steps(report).map(({ key, state }) => [key, state])).toEqual([
    ['readListing', 'done'],
    ['reviewPhotos', 'done'],
    ['writeReview', 'waiting'],
  ]);
  expect(stepFor(report, 'reviewPhotos')).toMatchObject({
    fill: 1,
    detailKey: 'photosReviewed',
    detailValues: { complete: 1, supplied: 1 },
  });
});

it('shows partially saved photos while a PDF update waits for remaining reviews', () => {
  const report: AnalysisReport = {
    ...incomplete,
    status: 'queued',
    activity: { state: 'queued' },
    review: {
      ...incomplete.review!,
      state: 'pending',
      images: { supplied: 3, selected: 3, complete: 1, unavailable: 0, skipped: 0 },
    },
  };

  expect(stepFor(report, 'reviewPhotos')).toEqual({
    key: 'reviewPhotos',
    state: 'waiting',
    fill: 1 / 3,
    detailKey: 'photosReviewed',
    detailValues: { complete: 1, supplied: 3 },
  });
});

it('writes the final review after all selected photos complete despite policy skips', () => {
  const report: AnalysisReport = {
    ...incomplete,
    activity: { state: 'running', leaseExpiresAt: '2026-10-05T12:00:05Z' },
    review: {
      ...incomplete.review!,
      images: { supplied: 26, selected: 24, complete: 24, unavailable: 0, skipped: 2 },
    },
  };

  expect(steps(report).map(({ key, state }) => [key, state])).toEqual([
    ['readListing', 'done'],
    ['reviewPhotos', 'done'],
    ['writeReview', 'active'],
  ]);
  expect(stepFor(report, 'writeReview')?.fill).toBe(0.5);
  expect(stepFor(report, 'reviewPhotos')).toMatchObject({
    fill: 1,
    detailKey: 'photosReviewed',
    detailValues: { complete: 24, supplied: 26 },
  });
});

it('marks read listing done and photos active while photos are reviewed', () => {
  const report: AnalysisReport = {
    ...incomplete,
    activity: { state: 'running', leaseExpiresAt: '2026-10-05T12:00:05Z' },
    review: {
      ...incomplete.review!,
      images: { supplied: 3, selected: 3, complete: 1, unavailable: 0, skipped: 0 },
    },
  };

  expect(steps(report).map(({ key, state }) => [key, state])).toEqual([
    ['readListing', 'done'],
    ['reviewPhotos', 'active'],
    ['writeReview', 'waiting'],
  ]);
});

it.each([
  ['stale', 'stale' as const],
  ['stopped', 'stopped' as const],
])('marks a step warning when progress is %s', (_label, state) => {
  const progress = { complete: false, state };

  expect(activitySteps(incomplete, progress).map(({ key, state: stepState }) => [key, stepState])).toEqual([
    ['readListing', 'done'],
    ['reviewPhotos', 'warning'],
    ['writeReview', 'waiting'],
  ]);
});

it('fills the photo bar by complete over selected photos', () => {
  const report: AnalysisReport = {
    ...incomplete,
    activity: { state: 'running', leaseExpiresAt: '2026-10-05T12:00:05Z' },
    review: {
      ...incomplete.review!,
      images: { supplied: 5, selected: 3, complete: 1, unavailable: 0, skipped: 2 },
    },
  };

  expect(stepFor(report, 'reviewPhotos')?.fill).toBe(1 / 3);
});

it('opens the report when the run is complete, stopped or stale, not while queued, running or checking live progress', () => {
  expect(canOpenReport({ complete: true, state: 'complete' })).toBe(true);
  expect(canOpenReport({ complete: false, state: 'stopped' })).toBe(true);
  expect(canOpenReport({ complete: false, state: 'stale' })).toBe(true);
  expect(canOpenReport({ complete: false, state: 'queued' })).toBe(false);
  expect(canOpenReport({ complete: false, state: 'running' })).toBe(false);
  expect(canOpenReport({ state: 'checking', complete: false })).toBe(false);
});
