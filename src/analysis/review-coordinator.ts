import { withPhotoTiming, measurePhotoPhase } from "@/diagnostics/photo-timings";
import { createHash } from 'node:crypto';
import type { ReviewProgress } from '@/domain/analysis';
import { completedReviewProgress, finalizeProgress, initialReviewProgress, markImage, markIncomplete, markPassComplete, markUnavailable, recountUnavailable } from '@/analysis/review-progress';
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
  return initialReviewProgress(snapshot.imageManifest, snapshot.mode === 'disabled');
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
  let progress = reviewProgress(snapshot);
  let progressWrites = Promise.resolve();
  const emitProgress = () => {
    const update = structuredClone(progress);
    progressWrites = progressWrites.then(async () => { await deps.progress?.(update); });
    return progressWrites;
  };
  const executions = await repository.loadExecutions(lease.analysisId, lease.runId);
  const committed = executions.find(execution => execution.pass === 'final' && execution.result && execution.resultHash);
  if (committed) {
    return completedReviewProgress(snapshot.imageManifest, progress.images.selected);
  }
  if (snapshot.mode === 'disabled') {
    await emitProgress();
    return progress;
  }
  const unavailable = async (pass: 'text' | 'image' | 'final', evidenceId?: string) => {
    progress = markUnavailable(progress, pass, evidenceId);
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
    if (executions.some(execution => execution.analysisId === lease.analysisId && execution.runId === lease.runId && execution.snapshotId === snapshot.id && execution.pass === 'image' && execution.imageEvidenceId === item.evidenceId && execution.result && execution.resultHash)) progress = markImage(progress, item.evidenceId, 'complete');
  }
  if (executions.some(execution => execution.analysisId === lease.analysisId && execution.runId === lease.runId && execution.snapshotId === snapshot.id && execution.pass === 'text' && execution.result && execution.resultHash)) progress = markPassComplete(progress, 'text');
  await emitProgress();
  const text = await perform(input('text'));
  if (text) {
    completed.push({ executionId: text.id, pass: 'text', result: text.result });
    progress = markPassComplete(progress, 'text');
    await emitProgress();
  }
  const reviewImage = async (image: typeof selected[number]): Promise<CompletedReview | undefined> => withPhotoTiming(image.evidenceId, async () => {
    if (image.status !== 'accepted' || !image.storageKey || !image.contentHash) {
      return unavailable('image', image.evidenceId);
    }
    // A durable result needs its pinned identity, not another read of the image.
    const cached = executions.find(execution => execution.analysisId === lease.analysisId
      && execution.runId === lease.runId && execution.snapshotId === snapshot.id
      && execution.pass === 'image' && execution.imageEvidenceId === image.evidenceId
      // SQL owns the committed hash; JSONB text differs from JS canonical JSON.
      && execution.result && execution.resultHash);
    if (cached?.result) {
      progress = markImage(progress, image.evidenceId, 'complete');
      await emitProgress();
      return { executionId: cached.id, pass: 'image', imageEvidenceId: image.evidenceId, result: cached.result };
    }
    progress = markImage(progress, image.evidenceId, 'running');
    await emitProgress();
    let capability: unknown;
    try {
      capability = await measurePhotoPhase("capability_verification", () => deps.imageCapability(image.evidenceId, image.storageKey!, image.contentHash!));
    }
    catch {
      return unavailable('image', image.evidenceId);
    }
    const reviewed = await perform({ ...input('image'), imageEvidenceId: image.evidenceId, images: [{ evidenceId: image.evidenceId, capability }] });
    if (reviewed) {
      progress = markImage(progress, image.evidenceId, 'complete');
      await emitProgress();
      return { executionId: reviewed.id, pass: 'image', imageEvidenceId: image.evidenceId, result: reviewed.result };
    }
  });
  const imageResults: (CompletedReview | undefined)[] = new Array(selected.length);
  let nextImage = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && nextImage < selected.length) {
      const index = nextImage++;
      try {
        imageResults[index] = await reviewImage(selected[index]!);
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  // Drain started tasks before returning an error so lease renewal covers their commits.
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, worker));
  if (failed) throw failure;
  // Repository validation requires text first, then images in manifest order.
  completed.push(...imageResults.filter((result): result is CompletedReview => result !== undefined));
  progress = recountUnavailable(progress);
  if (completed.length !== selected.length + 1) {
    progress = markIncomplete(progress);
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
  progress = finalizeProgress(progress);
  // Successful final commit publishes atomically; no later progress write may replace it.
  return progress;
}
