'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckIcon, CircleNotchIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';
import type { AnalysisReport } from '@/domain/analysis';
import { activityState } from './activity-state';

export function ActivityJournal({report}:{report:AnalysisReport}) {
 const [clock,setClock] = useState<{now:number;online:boolean}|null>(null);
 const initialComplete = activityState(report,0,true).complete;
 const [folded,setFolded] = useState(initialComplete);
 const [seenComplete,setSeenComplete] = useState(initialComplete);
 const reduced = useSyncExternalStore(callback=>{const media=window.matchMedia?.('(prefers-reduced-motion: reduce)');media?.addEventListener('change',callback);return ()=>media?.removeEventListener('change',callback);},()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,()=>false);
 const [folding,setFolding] = useState(false);
 const progress = activityState(report,clock?.now ?? Infinity,clock?.online ?? true);
 useEffect(()=>{
  const update=()=>setClock({now:Date.now(),online:navigator.onLine});
  const first=window.setTimeout(update,0);const timer=window.setInterval(update,1000);
  window.addEventListener('online',update);window.addEventListener('offline',update);
  return ()=>{window.clearTimeout(first);window.clearInterval(timer);window.removeEventListener('online',update);window.removeEventListener('offline',update);};
 },[]);
 if(seenComplete !== progress.complete) {
  setSeenComplete(progress.complete);
  setFolded(progress.complete && reduced);
  setFolding(progress.complete && !reduced);
 }
 useEffect(()=>{
  if(!folding) return;
  const finish=()=>{setFolded(true);setFolding(false);};
  const timer=window.setTimeout(finish,2100);
  return ()=>window.clearTimeout(timer);
 },[folding]);
 if(folding && reduced){setFolded(true);setFolding(false);}
 const review=report.review;
 const done=[review?.text==='complete',!!review && review.state !== 'pending' && review.state !== 'disabled' && review.text === 'complete' && review.images.complete===review.images.supplied && review.images.unavailable===0 && review.images.skipped===0,review?.final==='complete'];
 const current=done.findIndex(value=>!value);
 const running=progress.state==='running';
 const details=[review?.text==='complete'?'Listing checked':review?.text==='unavailable'?'Unavailable':current===0&&running?'Reading listing':'Waiting to read listing',review && review.state !== 'pending' ? review.images.supplied === 0 ? 'No supplied photos' : `${review.images.complete} of ${review.images.supplied} reviewed${review.images.unavailable ? ` · ${review.images.unavailable} unavailable` : ''}${review.images.skipped ? ` · ${review.images.skipped} not reviewed` : ''}` : 'Waiting for photos',review?.final==='complete'?'Ready to read':review?.final==='unavailable'?'Unavailable':current===2&&running?'Writing your review':'Not started'];
 const copy=progress.state==='stale'?'We cannot confirm processing is still active. Your partial findings are saved.':progress.state==='stopped'?'Processing has stopped. Your partial findings are saved.':progress.state==='queued'?'Waiting to start. Your findings will appear as they become available.':progress.state==='running'?'The review updates automatically.':'Your review is ready to read.';
 if(folded && progress.complete) return <div className="activity-journal activity-compact" role="status"><span className="journal-dot activity-done"><CheckIcon aria-hidden="true"/></span><span>Review complete</span></div>;
 return <section className={`activity-journal activity-${progress.state} ${folding?'activity-folding':''}`} aria-label="Review progress">
  <ol className="activity-steps">{['Read listing','Review photos','Write review'].map((label,index)=><li key={label} className={`activity-step ${done[index]?'activity-done':''} ${index===current?'activity-current':''}`}>
   <span className="journal-dot">{done[index]?<CheckIcon aria-hidden="true"/>:index===current&&running?<CircleNotchIcon className="activity-spin" aria-hidden="true"/>:index===current&&(progress.state==='stopped'||progress.state==='stale')?<WarningIcon aria-hidden="true"/>:null}</span>
   <div className="activity-label"><span>{label}</span><small>{details[index]}</small></div>
  </li>)}</ol>
  {folding?<span className="activity-completion-label">Review complete</span>:<p className="activity-message" role="status">{copy}</p>}
 </section>;
}
