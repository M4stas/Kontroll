import type { AnalysisReport } from '@/domain/analysis';
export function activityState(report: AnalysisReport, now: number, online: boolean) {
 const review = report.review;
 const complete = report.status === 'complete' && review?.state === 'complete' && review.text === 'complete' && review.final === 'complete' && review.images.complete === review.images.selected && review.images.unavailable === 0;
 let state: 'complete' | 'stopped' | 'queued' | 'running' | 'stale';
 if (complete) state = 'complete';
 else if (report.status === 'failed' || review?.state === 'disabled' || report.status === 'complete') state = 'stopped';
 else if (!online) state = 'stale';
 else if (report.activity?.state === 'running') state = report.activity.leaseExpiresAt && Date.parse(report.activity.leaseExpiresAt) > now ? 'running' : 'stale';
 else if (review?.state === 'incomplete' && !report.activity) state = 'stopped';
 else state = report.activity?.state ?? (report.status === 'queued' ? 'queued' : 'stale');
 return {complete, state};
}
