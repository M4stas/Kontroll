'use client';

import type { CSSProperties } from 'react';
import { ArrowRightIcon, CircleNotchIcon } from '@phosphor-icons/react/dist/ssr';
import { useTranslations } from 'next-intl';
import { BackgroundCheckLine, type ReportWithBackgroundCheck } from './background-check';
import type { AnalysisReport } from '@/domain/analysis';
import { PhoneBottomBar } from '@/components/phone-bottom-bar';
import { DiagnosticsPanel } from '@/features/diagnostics/diagnostics-panel';
import { activitySteps, canOpenReport } from './activity-steps';
import { EvidenceImage } from './evidence-image';
import { RetryReview } from './retry-review';
import { useActivityProgress } from './use-activity-progress';
import { vehicleTitle } from './vehicle-title';

export function ReportProgress({ report, diagnosticsEnabled, onOpen }: {
  report: ReportWithBackgroundCheck;
  diagnosticsEnabled: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('Report');
  const progress = useActivityProgress(report);
  const steps = activitySteps(report, progress);
  const listingSourceId = report.evidence.find(item => item.sourceClass === 'listing')?.sourceId ??
    report.vehicleFacts.find(fact => ['make_model', 'make', 'model'].includes(fact.key))?.sourceId;
  const address = listingSourceId ? report.sources[listingSourceId]?.url : undefined;
  const photos = report.review?.images.items ?? [];
  const statusKey = progress.state === 'checking' ? 'checkingLiveProgress' :
    progress.state === 'complete' ? 'ready' : progress.state;
  const attention = progress.state === 'stale' || progress.state === 'stopped';

  return <section className="review-progress" aria-label={t('activity.progress')}>
    <h1 className="review-progress-title" lang={report.locale}>{vehicleTitle(report) || t('verdict.pending')}</h1>
    {address ? <p className="review-progress-address">{address}</p> : null}
    <ol className="review-progress-labels">
      {steps.map(step => <li key={step.key} data-state={step.state}>
        <span className="review-progress-bar" aria-hidden="true" style={{ '--f': step.fill } as CSSProperties} />
        <b>{t(`activity.steps.${step.key}`)}</b>
        <span>{t(`activity.${step.detailKey}`, step.detailValues)}
          {step.detailKey === 'photosReviewed' && report.review?.images.unavailable ? t('activity.photosUnavailable', { count: report.review.images.unavailable }) : null}
          {step.detailKey === 'photosReviewed' && report.review?.images.skipped ? t('activity.photosNotReviewed', { count: report.review.images.skipped }) : null}
        </span>
      </li>)}
    </ol>
    <BackgroundCheckLine backgroundCheck={report.backgroundCheck} />
    {report.review?.images.supplied === 0 && !steps.some(step => step.detailKey === 'noSuppliedPhotos') ? <p className="review-progress-empty">{t('activity.noSuppliedPhotos')}</p> : null}
    {photos.length > 0 ? <ul className="review-progress-photos" aria-label={t('review.photoStatuses')}>
      {photos.map((photo, index) => {
        const label = t('review.photoNumber', { number: index + 1 });
        const evidence = report.evidence.find(item => item.id === photo.evidenceId);
        const stateLabel = t(`review.imageStatus.${photo.state}`);
        return <li key={photo.evidenceId} data-state={photo.state} aria-label={`${label}: ${stateLabel}`}>
          {photo.state === 'complete' && evidence?.imageUrl ? <EvidenceImage key={evidence.imageUrl} alt={label} src={evidence.imageUrl} fill sizes="(max-width: 639px) 50vw, 25vw" containerClassName="review-progress-photo" className="object-cover" fallbackClassName="review-progress-photo-unavailable" unavailableText={t('review.imageStatus.unavailable')} /> :
            photo.state === 'unavailable' || photo.state === 'skipped' || photo.state === 'complete' ? <span>{photo.state === 'complete' ? t('review.imageStatus.unavailable') : stateLabel}</span> : null}
        </li>;
      })}
    </ul> : null}
    <PhoneBottomBar className="review-progress-actions">
      <button className="primary-button review-progress-open" type="button" disabled={!canOpenReport(progress)} onClick={onOpen}>
        {t('activity.openReport')}<ArrowRightIcon aria-hidden="true" />
      </button>
      <p className={`review-progress-status${attention ? ' review-progress-attention' : ''}`} role="status">
        {progress.state === 'running' ? <CircleNotchIcon className="review-progress-spin" aria-hidden="true" /> : null}
        {t(`activity.${statusKey}`)}
      </p>
      {report.review?.state === 'incomplete' && report.activity?.state !== 'running' && report.activity?.state !== 'queued' ? <RetryReview key={`${report.publicId}:${report.updatedAt}`} publicId={report.publicId} /> : null}
      <DiagnosticsPanel publicId={report.publicId} enabled={diagnosticsEnabled} />
    </PhoneBottomBar>
  </section>;
}

export function ReportCompletion({ report }: { report: AnalysisReport }) {
  const t = useTranslations('Report.activity');
  const progress = useActivityProgress(report);
  return <p className={`report-completion${progress.state === 'stale' || progress.state === 'stopped' ? ' review-progress-attention' : ''}`} role="status">
    {progress.state === 'complete' ? t('completeWithPhotos', { count: report.review?.images.complete ?? 0 }) :
      t(progress.state === 'checking' ? 'checkingLiveProgress' : progress.state === 'running' ? 'running' : progress.state)}
  </p>;
}
