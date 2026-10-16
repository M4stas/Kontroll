'use client';

import { useEffect, useState } from 'react';
import type { AnalysisReport } from '@/domain/analysis';
import { activityState } from './activity-state';
import type { ActivityProgress } from './activity-steps';

export function useActivityProgress(report: AnalysisReport): ActivityProgress {
  const [clock, setClock] = useState<{ now: number; online: boolean } | null>(null);
  useEffect(() => {
    const update = () => setClock({ now: Date.now(), online: navigator.onLine });
    const first = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1000);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const progress = activityState(report, clock?.now ?? Infinity, clock?.online ?? true);
  return clock === null && report.activity?.state === 'running' && progress.state === 'stale'
    ? { ...progress, state: 'checking' }
    : progress;
}
