'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckIcon, CircleNotchIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { useTranslations } from 'next-intl';
import type { AnalysisReport } from '@/domain/analysis';
import { activityState } from './activity-state';

export function ActivityJournal({report}:{report:AnalysisReport}) {
 const t = useTranslations('Report.activity');
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
 const checkingLiveProgress=clock===null&&report.activity?.state==='running'&&progress.state==='stale';
 const displayState=checkingLiveProgress?'checking':progress.state;
 const done=[review?.text==='complete',!!review && review.state !== 'pending' && review.state !== 'disabled' && review.text === 'complete' && review.images.complete===review.images.supplied && review.images.unavailable===0 && review.images.skipped===0,review?.final==='complete'];
 const current=done.findIndex(value=>!value);
 const running=progress.state==='running';
 const details=[review?.text==='complete'?t('listingChecked'):review?.text==='unavailable'?t('unavailable'):current===0&&running?t('readingListing'):t('waitingToReadListing'),review && review.state !== 'pending' ? review.images.supplied === 0 ? t('noSuppliedPhotos') : `${t('photosReviewed', {complete: review.images.complete, supplied: review.images.supplied})}${review.images.unavailable ? t('photosUnavailable', {count: review.images.unavailable}) : ''}${review.images.skipped ? t('photosNotReviewed', {count: review.images.skipped}) : ''}` : t('waitingForPhotos'),review?.final==='complete'?t('readyToRead'):review?.final==='unavailable'?t('unavailable'):current===2&&running?t('writingReview'):t('notStarted')];
 const copy=checkingLiveProgress?t('checkingLiveProgress'):progress.state==='stale'?t('stale'):progress.state==='stopped'?t('stopped'):progress.state==='queued'?t('queued'):progress.state==='running'?t('running'):t('ready');
 if(folded && progress.complete) return <div className="activity-journal activity-compact" role="status"><span className="journal-dot activity-done"><CheckIcon aria-hidden="true"/></span><span>{t('complete')}</span></div>;
 return <section className={`activity-journal activity-${displayState} ${folding?'activity-folding':''}`} aria-label={t('progress')}>
  <ol className="activity-steps">{[t('steps.readListing'),t('steps.reviewPhotos'),t('steps.writeReview')].map((label,index)=><li key={label} className={`activity-step ${done[index]?'activity-done':''} ${index===current?'activity-current':''}`}>
   <span className="journal-dot">{done[index]?<CheckIcon aria-hidden="true"/>:index===current&&running?<CircleNotchIcon className="activity-spin" aria-hidden="true"/>:index===current&&!checkingLiveProgress&&(progress.state==='stopped'||progress.state==='stale')?<WarningIcon aria-hidden="true"/>:null}</span>
   <div className="activity-label"><span>{label}</span><small>{details[index]}</small></div>
  </li>)}</ol>
  {folding?<span className="activity-completion-label">{t('complete')}</span>:<p className="activity-message" role="status">{copy}</p>}
 </section>;
}
