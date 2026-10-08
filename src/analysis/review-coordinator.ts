import { createHash } from 'node:crypto';
import type { ReviewProgress } from '@/domain/analysis';
import type { CompletedReview, DataReviewer, ReviewInput, ReviewObservation, ReviewResult } from '@/insights/types';
import { ReviewResultSchema } from '@/insights/provider';
import { canonicalReviewJson, type ReviewExecutionsRepository, type ReviewLease, type ReviewPassPin, type ReviewPublication, type ReviewRunSnapshot } from '@/server/repositories/review-executions';

interface Dependencies {
  lease: ReviewLease;
  snapshot: ReviewRunSnapshot;
  repository: Pick<ReviewExecutionsRepository, 'loadExecutions' | 'ensureExecution' | 'startAttempt' | 'commitAttempt'>;
  reviewer(pin: ReviewPassPin): DataReviewer;
  imageCapability(evidenceId: string, storageKey: string, contentHash: string): Promise<unknown>;
  publication(result: ReviewResult, prior: readonly CompletedReview[]): ReviewPublication;
  progress?(progress: ReviewProgress): Promise<void>;
  shouldFinalize?(): Promise<boolean>;
  assertLease?(): void | Promise<void>;
}

export function reviewProgress(snapshot: ReviewRunSnapshot): ReviewProgress {
  const manifest = snapshot.imageManifest;
  return { state: snapshot.mode === 'disabled' ? 'disabled' : 'running', text: 'pending', images: { supplied: manifest.counts.supplied, selected: manifest.counts.selected, complete: 0, unavailable: manifest.counts.unavailable + manifest.counts.rejected, skipped: manifest.counts.skipped, items: manifest.images.map(image => ({ evidenceId: image.evidenceId, state: image.status === 'unavailable' || image.status === 'rejected' ? 'unavailable' : !image.selected || image.status === 'skipped' ? 'skipped' : 'pending' })) }, final: 'pending' };
}

export class ReviewRetryError extends Error {
  readonly transient = true;
  constructor() {
    super('data_review_incomplete');
  }
}

/** Exact structured duplicates only; original pass records remain immutable in audit. */
export function mergedReviewObservations(final: ReviewResult, prior: readonly CompletedReview[]): ReviewObservation[] {
  const seen = new Set<string>();
  return [...prior.map(review => ({ scope: review.executionId, result: review.result })), { scope: 'final', result: final }].flatMap(({ scope, result }) => result.observations.flatMap(observation => {
    const fields = { evidenceIds: observation.evidenceIds, category: observation.category, title: observation.title, severity: observation.severity, explanation: observation.explanation, recommendedAction: observation.recommendedAction, confidence: observation.confidence };
    const key = canonicalReviewJson({ ...fields, evidenceIds: [...fields.evidenceIds].sort() });
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ ...observation, id: createHash('sha256').update(`${scope}:${observation.id}`).digest('hex') }];
  }));
}

export async function coordinateReviews(deps: Dependencies): Promise<ReviewProgress> {
  const { snapshot, repository, lease } = deps;
  const progress = reviewProgress(snapshot);
  const emitProgress = async () => deps.progress?.(structuredClone(progress));
  const executions = await repository.loadExecutions(lease.analysisId, lease.runId);
  const committed = executions.find(execution => execution.pass === 'final' && execution.result && execution.resultHash);
  if (committed) {
    return { ...progress, state: 'complete', text: 'complete', images: { ...progress.images, complete: progress.images.selected, items: progress.images.items?.map(item => ({ ...item, state: snapshot.imageManifest.images.find(image => image.evidenceId === item.evidenceId)?.selected ? 'complete' : item.state })) }, final: 'complete' };
  }
  if (snapshot.mode === 'disabled') {
    await emitProgress();
    return progress;
  }
  const unavailable = async (pass: 'text' | 'image' | 'final', evidenceId?: string) => {
    progress.state = 'incomplete';
    if (pass === 'image') {
      const item = progress.images.items?.find(item => item.evidenceId === evidenceId);
      if (item) item.state = 'unavailable';
      progress.images.unavailable = progress.images.items?.filter(item => item.state === 'unavailable').length ?? 0;
    } else {
      progress[pass] = 'unavailable';
    }
    await emitProgress();
    return undefined;
  };
  const selected = snapshot.imageManifest.images.filter(image => image.selected);
  const completed: CompletedReview[] = [];
  const input = (pass: ReviewInput['pass']): ReviewInput => ({ analysisId: lease.analysisId, runId: lease.runId, locale: snapshot.locale, pass, ...(pass === 'final' ? snapshot.finalInput ?? snapshot.input : snapshot.input), images: [] });
  const perform = async (reviewInput: ReviewInput): Promise<{
    id: string;
    result: ReviewResult;
  } | undefined> => {
    const pin = snapshot.passes[reviewInput.pass];
    if (pin.availability !== 'ready') {
      return unavailable(reviewInput.pass, reviewInput.imageEvidenceId);
    }
    await deps.assertLease?.();
    const execution = await repository.ensureExecution(lease, snapshot.id, { input: reviewInput });
    if (execution.result) {
      return { id: execution.id, result: execution.result };
    }
    const attempt = await repository.startAttempt(lease, execution.id);
    let result: ReviewResult;
    try {
      result = ReviewResultSchema.parse(await deps.reviewer(pin).review(reviewInput));
      const ids = new Set([...reviewInput.evidence.map(item => item.id), ...reviewInput.images.map(item => item.evidenceId)]);
      if (result.observations.some(observation => observation.evidenceIds.some(id => !ids.has(id)) || (reviewInput.pass === 'image' && !observation.evidenceIds.includes(reviewInput.imageEvidenceId!)))) {
        result = { schemaVersion: 1, observations: [], warnings: [{ code: 'invalid_output', message: 'Invalid supplied evidence reference.' }] };
      }
    }
    catch {
      result = { schemaVersion: 1, observations: [], warnings: [{ code: 'unavailable', message: 'Review unavailable.' }] };
    }
    await deps.assertLease?.();
    if (reviewInput.pass === 'final' && deps.shouldFinalize && !await deps.shouldFinalize()) {
      await repository.commitAttempt(lease, attempt.id, { outcome: 'lost', warningCode: 'superseded' });
      return undefined;
    }
    if (result.warnings.length) {
      await repository.commitAttempt(lease, attempt.id, { outcome: 'failure', warningCode: result.warnings[0]!.code });
      return unavailable(reviewInput.pass, reviewInput.imageEvidenceId);
    }
    const publication = reviewInput.pass === 'final' ? deps.publication(result, completed) : undefined;
    try {
      await repository.commitAttempt(lease, attempt.id, { outcome: 'success', result, ...(publication ? { publication } : {}) });
    } catch (error) {
      // Acceptance can win the analysis lock after the pre-commit current-run check.
      // A lost audit write still validates the marked lineage and the owned lease.
      if (reviewInput.pass !== 'final' || !deps.shouldFinalize || await deps.shouldFinalize()) throw error;
      await repository.commitAttempt(lease, attempt.id, { outcome: 'lost', warningCode: 'superseded' });
      return undefined;
    }
    return { id: execution.id, result };
  };
  for (const item of progress.images.items ?? []) {
    if (executions.some(execution => execution.analysisId === lease.analysisId && execution.runId === lease.runId && execution.snapshotId === snapshot.id && execution.pass === 'image' && execution.imageEvidenceId === item.evidenceId && execution.result && execution.resultHash)) item.state = 'complete';
  }
  progress.images.complete = progress.images.items!.filter(item => item.state === 'complete').length;
  if (executions.some(execution => execution.analysisId === lease.analysisId && execution.runId === lease.runId && execution.snapshotId === snapshot.id && execution.pass === 'text' && execution.result && execution.resultHash)) progress.text = 'complete';
  await emitProgress();
  const text = await perform(input('text'));
  if (text) {
    completed.push({ executionId: text.id, pass: 'text', result: text.result });
    progress.text = 'complete';
    await emitProgress();
  }
  for (const image of selected) {
    if (image.status !== 'accepted' || !image.storageKey || !image.contentHash) {
      await unavailable('image', image.evidenceId);
      continue;
    }
    // A durable result needs its pinned identity, not another read of the image.
    const cached = executions.find(execution => execution.analysisId === lease.analysisId
      && execution.runId === lease.runId && execution.snapshotId === snapshot.id
      && execution.pass === 'image' && execution.imageEvidenceId === image.evidenceId
      // SQL owns the committed hash; JSONB text differs from JS canonical JSON.
      && execution.result && execution.resultHash);
    if (cached?.result) {
      completed.push({ executionId: cached.id, pass: 'image', imageEvidenceId: image.evidenceId, result: cached.result });
      progress.images.items!.find(item => item.evidenceId === image.evidenceId)!.state = 'complete';
      progress.images.complete = progress.images.items!.filter(item => item.state === 'complete').length;
      await emitProgress();
      continue;
    }
    progress.images.items!.find(item => item.evidenceId === image.evidenceId)!.state = 'running';
    await emitProgress();
    let capability: unknown;
    try {
      capability = await deps.imageCapability(image.evidenceId, image.storageKey, image.contentHash);
    }
    catch {
      await unavailable('image', image.evidenceId);
      continue;
    }
    const reviewed = await perform({ ...input('image'), imageEvidenceId: image.evidenceId, images: [{ evidenceId: image.evidenceId, capability }] });
    if (reviewed) {
      completed.push({ executionId: reviewed.id, pass: 'image', imageEvidenceId: image.evidenceId, result: reviewed.result });
      progress.images.items!.find(item => item.evidenceId === image.evidenceId)!.state = 'complete';
      progress.images.complete = progress.images.items!.filter(item => item.state === 'complete').length;
      await emitProgress();
    }
  }
  progress.images.unavailable = progress.images.items!.filter(item => item.state === 'unavailable').length;
  if (completed.length !== selected.length + 1) {
    progress.state = 'incomplete';
    await emitProgress();
    throw new ReviewRetryError();
  }
  // A PDF child owns the next final assessment; finish this run's photos first.
  if (deps.shouldFinalize && !await deps.shouldFinalize()) return progress;
  const final = await perform({ ...input('final'), priorReviews: completed });
  if (!final) {
    if (deps.shouldFinalize && !await deps.shouldFinalize()) return progress;
    throw new ReviewRetryError();
  }
  progress.state = 'complete';
  progress.final = 'complete';
  // Successful final commit publishes atomically; no later progress write may replace it.
  return progress;
}
