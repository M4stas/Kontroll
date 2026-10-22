'use client';

import { useTranslations } from 'next-intl';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/ssr';
import type { AnalysisReport } from '@/domain/analysis';
import type { WebsiteBackgroundCheckState } from '@/listings/background-check';

export interface ReportBackgroundCheck {
  status: WebsiteBackgroundCheckState['status'];
  reason: WebsiteBackgroundCheckState['reason'];
  fetchedAt?: string;
  pdfUrl?: string;
}
export type ReportWithBackgroundCheck = AnalysisReport & { backgroundCheck?: ReportBackgroundCheck };

export function BackgroundCheckLine({ backgroundCheck }: { backgroundCheck?: ReportBackgroundCheck }) {
  const t = useTranslations('Report.backgroundCheck');
  if (!backgroundCheck) return null;
  const { status, reason, pdfUrl } = backgroundCheck;
  const label = t(status);
  return <p className="my-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" role="status" aria-busy={status === 'pending'}>
    <b>{t('heading')}:</b>
    {status === 'pending' ? <CircleNotchIcon className="review-progress-spin" aria-hidden="true" /> : null}
    {status === 'fetched' && pdfUrl ? <a className="underline underline-offset-4" href={pdfUrl}>{label}</a> : <span>{label}</span>}
    {status === 'unavailable' && reason ? <span>({t(`reasons.${reason}`)})</span> : null}
  </p>;
}
