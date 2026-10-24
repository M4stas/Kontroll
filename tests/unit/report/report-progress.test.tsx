import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { ReportProgress } from '@/features/report/report-progress';
import type { AnalysisReport } from '@/domain/analysis';
import en from '../../../messages/en.json';
import { sampleReport } from '../../fixtures/sample-report';

vi.mock('next/navigation', () => ({useRouter: () => ({refresh: vi.fn()})}));
const now = Date.parse('2026-10-05T12:00:00Z');
const running: AnalysisReport = {...sampleReport, status:'running', activity:{state:'running',leaseExpiresAt:'2026-10-05T12:00:05Z'}, review:{state:'running',text:'complete',final:'pending',images:{supplied:5,selected:4,complete:1,unavailable:1,skipped:1,items:['complete','pending','running','unavailable','skipped'].map((state,index)=>({evidenceId:`photo-${index}`,state:state as 'complete'|'pending'|'running'|'unavailable'|'skipped'}))}}, evidence:Array.from({length:5},(_,index)=>({...sampleReport.evidence[0]!,id:`photo-${index}`,sourceClass:'listing',imageUrl:`/photos/${index}.jpg`}))};
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
function renderProgress(report:AnalysisReport, diagnosticsEnabled=false, onOpen=vi.fn()) {
 return render(<ReportProgress report={report} diagnosticsEnabled={diagnosticsEnabled} onOpen={onOpen}/>, {wrapper:({children})=><NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Tallinn">{children}</NextIntlClientProvider>});
}
it('removes the spinner when a confirmed worker lease expires',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const {container}=renderProgress(running);
 act(()=>vi.advanceTimersByTime(1));
 expect(container.querySelector('.review-progress-spin')).not.toBeNull();
 act(()=>vi.advanceTimersByTime(6000));
 expect(container.querySelector('.review-progress-spin')).toBeNull();
 expect(screen.getByText(/cannot confirm processing/)).toBeVisible();
 expect(screen.getByRole('button',{name:'Open the report'})).toBeEnabled();
});
it('shows a neutral live-progress message before the client clock is initialized',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 renderProgress(running);
 expect(screen.getByText('Checking live progress…')).toBeVisible();
 expect(screen.queryByText(/cannot confirm processing/)).toBeNull();
 expect(screen.getByRole('button',{name:'Open the report'})).toBeDisabled();
});
it('shows an expired lease warning once the client clock is initialized',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 renderProgress({...running,activity:{state:'running',leaseExpiresAt:'2026-10-05T11:59:59Z'}});
 act(()=>vi.advanceTimersByTime(1));
 expect(screen.getByText(/cannot confirm processing/)).toBeVisible();
 expect(screen.getByRole('button',{name:'Open the report'})).toBeEnabled();
});
it('shows one tile per supplied photo with its review state',()=>{
 renderProgress(running);
 const grid=screen.getByRole('list',{name:'Photo review statuses'});
 expect(within(grid).getAllByRole('listitem')).toHaveLength(5);
 ['Review complete','Waiting for review','Review in progress','Review unavailable','Not selected'].forEach((state,index)=>expect(within(grid).getByRole('listitem',{name:`Photo ${index+1}: ${state}`})).toBeInTheDocument());
});
it('loads photos only for reviewed tiles',()=>{
 renderProgress(running);
 const grid=screen.getByRole('list',{name:'Photo review statuses'});
 expect(within(grid).getAllByRole('img')).toHaveLength(1);
 expect(new URL(within(grid).getByRole('img',{name:'Photo 1'}).getAttribute('src')!,location.href).pathname).toBe('/photos/0.jpg');
});
it('hides the grid and says so when no photos were supplied',()=>{
 renderProgress({...running,review:{...running.review!,images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0,items:[]}}});
 expect(screen.queryByRole('list',{name:'Photo review statuses'})).toBeNull();
 expect(screen.getByText('No supplied photos')).toBeVisible();
});
it('keeps Open the report off until the run is over',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);const onOpen=vi.fn();
 const {rerender}=renderProgress(running,false,onOpen);
 act(()=>vi.advanceTimersByTime(1));
 fireEvent.click(screen.getByRole('button',{name:'Open the report'}));expect(onOpen).not.toHaveBeenCalled();
 rerender(<ReportProgress report={{...running,status:'complete'}} diagnosticsEnabled={false} onOpen={onOpen}/>);
 fireEvent.click(screen.getByRole('button',{name:'Open the report'}));expect(onOpen).toHaveBeenCalledOnce();
});
it('shows retry and diagnostics beside the status line when they apply',()=>{
 const {container}=renderProgress({...running,status:'partial',activity:{state:'stopped'},review:{...running.review!,state:'incomplete'}},true);
 const actions=container.querySelector('.review-progress-actions')!;
 expect(within(actions as HTMLElement).getByRole('button',{name:'Retry review'})).toBeVisible();
 expect(within(actions as HTMLElement).getByRole('button',{name:'Live diagnostics'})).toBeVisible();
 expect(within(actions as HTMLElement).getByText(/Processing has stopped/)).toBeVisible();
});
it('groups each progress bar with its step and keeps review actions in the shared phone bar',()=>{
 const {container}=renderProgress({...running,status:'partial',activity:{state:'stopped'},review:{...running.review!,state:'incomplete'}},true);
 const stepGroups=Array.from(container.querySelectorAll('.review-progress-labels > li'));
 expect(stepGroups).toHaveLength(3);
 stepGroups.forEach(step=>{
  expect(step.querySelector('.review-progress-bar')).toHaveAttribute('aria-hidden','true');
  expect(step.querySelector('b')).not.toBeNull();
  expect(step.querySelector('span:not(.review-progress-bar)')).not.toBeNull();
 });
 const actions=container.querySelector('.phone-bottom-bar.review-progress-actions');
 expect(actions).not.toBeNull();
 expect(within(actions as HTMLElement).getByRole('button',{name:'Open the report'})).toBeEnabled();
 expect(within(actions as HTMLElement).getByRole('button',{name:'Retry review'})).toBeVisible();
 expect(within(actions as HTMLElement).getByRole('button',{name:'Live diagnostics'})).toBeVisible();
 expect(within(actions as HTMLElement).getByText(/Processing has stopped/)).toBeVisible();
});
it('shows the vehicle title and snapshot-keyed listing address as plain text',()=>{
 renderProgress({...running,sources:{'listing-source':{verification:'unverified',url:'https://www.auto24.ee/soidukid/123456'}}});
 expect(screen.getByRole('heading',{name:'Toyota Avensis'})).toHaveAttribute('lang','en');
 expect(screen.getByText('https://www.auto24.ee/soidukid/123456')).not.toHaveAttribute('href');
});

it.each([
 ['en','Waiting for the background check'],
 ['et','Taustakontrolli ootel'],
] as const)('renders the background check wait in %s before the final step', (locale,message)=>{
 const report:AnalysisReport={...running,locale,review:{...running.review!,backgroundCheck:'waiting',images:{supplied:0,selected:0,complete:0,unavailable:0,skipped:0}}};
 const {container}=renderProgress(report);
 const groups=Array.from(container.querySelectorAll('.review-progress-labels > li'));
 expect(groups).toHaveLength(4);
 expect(groups[2]).toHaveTextContent(message);
 expect(groups[3]).toHaveAttribute('data-state','waiting');
 expect(groups[3]).not.toHaveTextContent('Writing your review');
});
