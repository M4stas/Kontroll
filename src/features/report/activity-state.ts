import type { AnalysisReport } from '@/domain/analysis';
import { isReviewComplete } from '@/analysis/review-progress';
export function activityState(report: AnalysisReport, now: number, online: boolean) {
 const review = report.review;
 const complete = report.status === 'complete' && isReviewComplete(review);
 let state: 'complete' | 'stopped' | 'queued' | 'running' | 'stale';
 if (complete) state = 'complete';
 else if (report.status === 'failed' || review?.state === 'disabled' || report.status === 'complete') state = 'stopped';
 else if (!online) state = 'stale';
 else if (report.activity?.state === 'running') state = report.activity.leaseExpiresAt && Date.parse(report.activity.leaseExpiresAt) > now ? 'running' : 'stale';
 else if (review?.state === 'incomplete' && !report.activity) state = 'stopped';
 else state = report.activity?.state ?? (report.status === 'queued' ? 'queued' : 'stale');
 return {complete, state};
}
