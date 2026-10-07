import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityJournal } from '@/features/report/activity-journal';
import { activityState } from '@/features/report/activity-state';
import type { AnalysisReport } from '@/domain/analysis';
import en from '../../messages/en.json';
import { sampleReport } from '../fixtures/sample-report';
const successful = {...sampleReport,status:'complete' as const,review:{state:'complete' as const,text:'complete' as const,final:'complete' as const,images:{supplied:1,selected:1,complete:1,unavailable:0,skipped:0}}};
const incomplete = {...successful,status:'running' as const,review:{state:'incomplete' as const,text:'complete' as const,final:'pending' as const,images:{supplied:3,selected:3,complete:1,unavailable:1,skipped:0}}};
const now = Date.parse('2026-10-05T12:00:00Z');
afterEach(() => {cleanup();vi.useRealTimers();});
function renderActivity(report: AnalysisReport) {
 return render(<ActivityJournal report={report}/>, {wrapper: ({children}) =>
  <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Tallinn">{children}</NextIntlClientProvider>});
}
it('loads completed reviews compact without replay', () => {
 renderActivity(successful);
 expect(screen.getByText('Review complete')).toBeInTheDocument();
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
});
it('folds a newly completed review after 2.1 seconds', () => {
 vi.useFakeTimers();
 const {rerender}=renderActivity({...successful,status:'running',review:undefined});
 rerender(<ActivityJournal report={successful}/>);
 expect(screen.getByText('Read listing')).toBeInTheDocument();
 act(()=>vi.advanceTimersByTime(2100));
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
 expect(screen.getByText('Review complete')).toBeInTheDocument();
});
it('reduces completion motion to an immediate compact state', () => {
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:()=>{},removeEventListener:()=>{}}));
 const {rerender}=renderActivity({...successful,status:'running',review:undefined});
 rerender(<ActivityJournal report={successful}/>);
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
 expect(screen.getByText('Review complete')).toBeInTheDocument();
 vi.unstubAllGlobals();
});

it('does not mark a pending empty inventory as reviewed', () => {
 renderActivity({...successful,status:'queued',review:{...successful.review,state:'pending',text:'pending',final:'pending',images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0}}});
 expect(screen.getByText('Review photos').closest('li')).not.toHaveClass('activity-done');
});

it('removes the spinner when a confirmed worker lease expires', () => {
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
 renderActivity({...successful,status:'running',review:undefined,activity:{state:'running',leaseExpiresAt:'2026-10-05T12:00:02Z'}});
 act(()=>vi.advanceTimersByTime(1));
 expect(document.querySelector('.activity-spin')).not.toBeNull();
 act(()=>vi.advanceTimersByTime(3000));
 expect(document.querySelector('.activity-spin')).toBeNull();
 expect(screen.getByText(/cannot confirm processing/)).toBeInTheDocument();
});
it('shows a neutral live-progress message before the client clock is initialized', () => {
 vi.useFakeTimers();vi.setSystemTime(now);
 const {container}=renderActivity({...successful,status:'running',review:undefined,activity:{state:'running',leaseExpiresAt:'2026-10-05T12:00:05Z'}});
 expect(screen.getByText('Checking live progress…')).toBeInTheDocument();
 expect(screen.queryByText(/cannot confirm processing/)).not.toBeInTheDocument();
 expect(container.querySelector('.activity-spin')).toBeNull();
 expect(container.querySelector('.activity-current .journal-dot svg')).toBeNull();
});
it('shows an expired lease warning once the client clock is initialized', () => {
 vi.useFakeTimers();vi.setSystemTime(now);
 const {container}=renderActivity({...successful,status:'running',review:undefined,activity:{state:'running',leaseExpiresAt:'2026-10-05T11:59:59Z'}});
 act(()=>vi.advanceTimersByTime(1));
 expect(screen.getByText(/cannot confirm processing/)).toBeInTheDocument();
 expect(container.querySelector('.activity-current .journal-dot svg')).not.toBeNull();
});
it.each([
 ['server-reported stale activity', {...successful,status:'running' as const,review:undefined,activity:{state:'stale' as const}}],
 ['server-reported stopped activity', {...successful,status:'running' as const,review:undefined,activity:{state:'stopped' as const}}],
 ['failed report', {...successful,status:'failed' as const,review:undefined,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:05Z'}}],
])('shows an immediate warning for %s', (_description,report) => {
 const {container}=renderActivity(report);
 expect(screen.queryByText('Checking live progress…')).not.toBeInTheDocument();
 expect(screen.getByText(/cannot confirm processing|processing has stopped/i)).toBeInTheDocument();
 expect(container.querySelector('.activity-current .journal-dot svg')).not.toBeNull();
});
it('keeps the completion timer through fresh report objects', () => {
 vi.useFakeTimers();const {rerender}=renderActivity({...successful,status:'running',review:undefined});
 rerender(<ActivityJournal report={successful}/>);act(()=>vi.advanceTimersByTime(1000));
 rerender(<ActivityJournal report={{...successful,updatedAt:'2026-10-05T12:00:00Z'}}/>);act(()=>vi.advanceTimersByTime(1100));
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
});
it('keeps completed circles out of the home-page loading spinner style', () => {
 const {container}=renderActivity(successful);
 expect(container.querySelector('.activity-dot')).toBeNull();
});

it('keeps the photo step running while an incomplete review has a live worker lease', () => {
 vi.useFakeTimers();vi.setSystemTime(now);
 const {container}=renderActivity({...incomplete,activity:{state:'running',leaseExpiresAt:'2026-10-05T12:00:05Z'}});
 act(()=>vi.advanceTimersByTime(1));
 expect(container.querySelector('.activity-journal')).toHaveClass('activity-running');
 expect(container.querySelector('.activity-spin')).not.toBeNull();
 expect(screen.getByText('1 of 3 reviewed · 1 unavailable')).toBeInTheDocument();
 expect(screen.queryByText('Review complete')).not.toBeInTheDocument();
});

it('shows an incomplete queued retry as queued when worker activity is queued', () => {
 expect(activityState({...incomplete,status:'queued',activity:{state:'queued'}},now,true)).toEqual({complete:false,state:'queued'});
});

it.each([
 ['no worker activity', {...incomplete,activity:undefined}],
 ['a stopped worker', {...incomplete,activity:{state:'stopped' as const}}],
])('keeps an incomplete review stopped with %s', (_description,report) => {
 expect(activityState(report,now,true).state).toBe('stopped');
});

it.each([
 ['an expired worker lease', {...incomplete,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T11:59:59Z'}},true],
 ['offline', {...incomplete,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:05Z'}},false],
])('marks an incomplete review stale with %s', (_description,report,online) => {
 expect(activityState(report,now,online).state).toBe('stale');
});

it.each([
 ['failed status', {...incomplete,status:'failed' as const,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:05Z'}},true],
 ['disabled review', {...incomplete,review:{...incomplete.review,state:'disabled' as const},activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:05Z'}},true],
 ['complete status', {...incomplete,status:'complete' as const,activity:{state:'running' as const,leaseExpiresAt:'2026-10-05T12:00:05Z'}},true],
])('keeps %s stopped despite a live lease', (_description,report,online) => {
 expect(activityState(report,now,online).state).toBe('stopped');
});
