import { describe, expect, it } from 'vitest';
import { activityState } from '@/features/report/activity-state';
import { sampleReport } from '../fixtures/sample-report';
describe('review activity', () => {
 it('requires successful review and all supplied photos before collapsing', () => {
  const report = {...sampleReport, status:'complete' as const, review:{state:'complete' as const,text:'complete' as const,final:'complete' as const,images:{supplied:2,selected:1,complete:1,unavailable:0,skipped:1}}};
  expect(activityState(report,0,true).complete).toBe(false);
  expect(activityState({...report,review:{...report.review,images:{...report.review.images,selected:2,complete:2,skipped:0}}},0,true).complete).toBe(true);
 });
 it('shows queued without a spinner, expired leases and offline stop activity', () => {
  const report = {...sampleReport,status:'running' as const,review:undefined,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:00Z'}};
  expect(activityState(report,Date.parse('2026-10-05T11:59:00Z'),true).state).toBe('running');
  expect(activityState(report,Date.parse('2026-10-05T12:01:00Z'),true).state).toBe('stale');
  expect(activityState(report,0,false).state).toBe('stale');
  expect(activityState({...report,activity:{state:'queued'}},0,true).state).toBe('queued');
 });
 it('never collapses failed, incomplete or disabled reviews', () => {
  for(const state of ['incomplete','disabled'] as const) expect(activityState({...sampleReport,review:{state,text:'unavailable',final:'unavailable',images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0}}},0,true).state).toBe('stopped');
 });
});
it('keeps incomplete reviews active while a worker owns a live lease',()=>{
 const report={...sampleReport,status:'partial' as const,activity:{state:'running' as const,leaseExpiresAt:'2099-01-01T00:00:00Z'},review:{state:'incomplete' as const,text:'complete' as const,final:'unavailable' as const,images:{supplied:1,selected:1,complete:0,unavailable:1,skipped:0}}};
 expect(activityState(report,0,true)).toEqual({state:'running',complete:false});
});
