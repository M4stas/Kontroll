import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityJournal } from '@/features/report/activity-journal';
import { sampleReport } from '../fixtures/sample-report';
const successful = {...sampleReport,status:'complete' as const,review:{state:'complete' as const,text:'complete' as const,final:'complete' as const,images:{supplied:1,selected:1,complete:1,unavailable:0,skipped:0}}};
afterEach(() => {cleanup();vi.useRealTimers();});
it('loads completed reviews compact without replay', () => {
 render(<ActivityJournal report={successful}/>);
 expect(screen.getByText('Review complete')).toBeInTheDocument();
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
});
it('folds a newly completed review after 2.1 seconds', () => {
 vi.useFakeTimers();
 const {rerender}=render(<ActivityJournal report={{...successful,status:'running',review:undefined}}/>);
 rerender(<ActivityJournal report={successful}/>);
 expect(screen.getByText('Read listing')).toBeInTheDocument();
 act(()=>vi.advanceTimersByTime(2100));
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
 expect(screen.getByText('Review complete')).toBeInTheDocument();
});
it('reduces completion motion to an immediate compact state', () => {
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:()=>{},removeEventListener:()=>{}}));
 const {rerender}=render(<ActivityJournal report={{...successful,status:'running',review:undefined}}/>);
 rerender(<ActivityJournal report={successful}/>);
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
 expect(screen.getByText('Review complete')).toBeInTheDocument();
 vi.unstubAllGlobals();
});

it('does not mark a pending empty inventory as reviewed', () => {
 render(<ActivityJournal report={{...successful,status:'queued',review:{...successful.review,state:'pending',text:'pending',final:'pending',images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0}}}}/>);
 expect(screen.getByText('Review photos').closest('li')).not.toHaveClass('activity-done');
});

it('removes the spinner when a confirmed worker lease expires', () => {
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
 render(<ActivityJournal report={{...successful,status:'running',review:undefined,activity:{state:'running',leaseExpiresAt:'2026-10-05T12:00:02Z'}}}/>);
 act(()=>vi.advanceTimersByTime(1));
 expect(document.querySelector('.activity-spin')).not.toBeNull();
 act(()=>vi.advanceTimersByTime(3000));
 expect(document.querySelector('.activity-spin')).toBeNull();
 expect(screen.getByText(/cannot confirm processing/)).toBeInTheDocument();
});
it('keeps the completion timer through fresh report objects', () => {
 vi.useFakeTimers();const {rerender}=render(<ActivityJournal report={{...successful,status:'running',review:undefined}}/>);
 rerender(<ActivityJournal report={successful}/>);act(()=>vi.advanceTimersByTime(1000));
 rerender(<ActivityJournal report={{...successful,updatedAt:'2026-10-05T12:00:00Z'}}/>);act(()=>vi.advanceTimersByTime(1100));
 expect(screen.queryByText('Read listing')).not.toBeInTheDocument();
});
it('keeps completed circles out of the home-page loading spinner style', () => {
 const {container}=render(<ActivityJournal report={successful}/>);
 expect(container.querySelector('.activity-dot')).toBeNull();
});
