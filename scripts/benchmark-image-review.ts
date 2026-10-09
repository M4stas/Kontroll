/** Compare image scheduling using a replay, or explicitly authorized live image calls. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';
import { coordinateReviews } from '@/analysis/review-coordinator';
import { normalizeVehicle } from '@/analysis/normalize';
import { createFallbackSnapshot } from '@/listings/fallback';
import { createCodexDataReviewer } from '@/insights/codex';
import { ReviewResultSchema } from '@/insights/provider';
import { createInsightImageCapabilityVerifier, issueInsightImageCapability } from '@/insights/image-capability';
import { AnalysisUploads } from '@/server/storage/uploads';
import type { ReviewExecutionRecord, ReviewLease, ReviewPassPin, ReviewRunSnapshot } from '@/server/repositories/review-executions';
import type { ReviewInput, ReviewResult } from '@/insights/types';

const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
function integer(name: string, fallback: number, maximum: number): number {
  const number = Number(value(name, String(fallback)));
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid ${name}`);
  return number;
}
const live = args.includes('--live');
if (live && !args.includes('--run')) throw new Error('Live model calls require --live --run.');
const imageCount = integer('--images', live ? 3 : 15, 64);
const rounds = integer('--rounds', live ? 1 : 5, 10);
const delayMs = integer('--delay-ms', 100, 10_000);
const baselineRef = value('--baseline-ref', '2710cd03a4a0afaf3f87d3e743a13d0ea4262a47')!;
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`], { encoding: 'utf8' }).trim();
const empty: ReviewResult = { schemaVersion: 1, observations: [], warnings: [] };
let snapshot: ReviewRunSnapshot;
let imageCapability: (id: string, key: string, hash: string) => Promise<unknown>;
let liveReviewer: ReturnType<typeof createCodexDataReviewer> | undefined;

if (live) {
  const envFile = value('--env-file');
  if (envFile) process.loadEnvFile(resolve(envFile));
  const snapshotId = value('--snapshot');
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.ANALYSIS_COOKIE_SECRET;
  if (!snapshotId || !origin || !key || !secret) throw new Error('Live mode requires --snapshot and the private Supabase/capability environment.');
  const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.from('review_run_snapshots').select('id,input_hash,created_at,snapshot').eq('id', snapshotId).single();
  if (error || !data) throw new Error('Cannot read the selected snapshot.');
  snapshot = { ...data.snapshot, id: data.id, inputHash: data.input_hash, createdAt: data.created_at } as ReviewRunSnapshot;
  const pin = snapshot.passes.image;
  if (pin.provider !== 'codex' || pin.model !== 'gpt-6-luna' || pin.reasoningEffort !== 'xhigh') {
    throw new Error('This benchmark requires the production Codex Luna xhigh image settings.');
  }
  const uploads = new AnalysisUploads(client);
  imageCapability = async (evidenceId, storageKey, contentHash) => {
    if (await uploads.getStoredContentHash(snapshot.analysisId, storageKey) !== contentHash) throw new Error('Image content changed.');
    return issueInsightImageCapability({ analysisId: snapshot.analysisId, evidenceId, storageKey, ...await uploads.createSignedRead(snapshot.analysisId, storageKey) }, secret);
  };
  liveReviewer = createCodexDataReviewer(pin, process.env, {
    imageUrlVerifier: createInsightImageCapabilityVerifier(secret), allowedStorageOrigins: [new URL(origin).origin],
  });
} else {
  const vehicle = normalizeVehicle(createFallbackSnapshot({ originalListingUrl: new URL('https://example.test/car'), pastedDescription: '', screenshotRefs: [] }));
  const pin: ReviewPassPin = {
    availability: 'ready', prompt: { content: 'Deterministic scheduling replay.', hash: 'replay' },
    options: { timeoutMs: 120_000, imageDetail: 'omitted', outputFormat: 'json_schema', outputStrict: true, outputSchemaVersion: 1, maxOutputTokens: null, temperature: null },
  };
  snapshot = {
    id: 'benchmark-snapshot', analysisId: 'benchmark-analysis', runId: 'benchmark-run', inputHash: 'benchmark',
    createdAt: new Date().toISOString(), preparationVersion: 1, schemaVersion: 1, locale: 'en', mode: 'split',
    input: { vehicle, listing: null, sourceRecords: [], evidence: [] },
    imageManifest: { counts: { supplied: imageCount, selected: imageCount, accepted: imageCount, unavailable: 0, rejected: 0, skipped: 0 },
      images: Array.from({ length: imageCount }, (_, index) => ({ evidenceId: `image-${index}`, selected: true, status: 'accepted', storageKey: `benchmark-analysis/${index}`, contentHash: `hash-${index}` })) },
    passes: { text: pin, image: { ...pin, options: { ...pin.options, imageDetail: 'high' } }, final: pin },
  };
  imageCapability = async () => ({});
}
const images = snapshot.imageManifest.images.filter(image => image.selected && image.status === 'accepted').slice(0, imageCount);
if (images.length !== imageCount) throw new Error('The snapshot has fewer accepted images than requested.');
snapshot = { ...snapshot, imageManifest: { counts: { supplied: imageCount, selected: imageCount, accepted: imageCount, unavailable: 0, rejected: 0, skipped: 0 }, images } };
const directory = await mkdtemp(join(tmpdir(), 'kontroll-image-benchmark-'));
try {
  const baselinePath = join(directory, 'baseline.ts');
  await writeFile(baselinePath, execFileSync('git', ['show', `${baselineCommit}:src/analysis/review-coordinator.ts`]), { mode: 0o600 });
  const baseline = (await import(pathToFileURL(baselinePath).href)).coordinateReviews as typeof coordinateReviews;
  const rows = [];
  for (let round = 0; round < rounds; round++) {
    const variants = round % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
    for (const variant of variants) {
      const coordinator = variant === 'baseline' ? baseline : coordinateReviews;
      const records: ReviewExecutionRecord[] = [];
      const imageTimings: Array<{ image: number; elapsedMs: number; observations: number; warnings: string[] }> = [];
      const imageResults: Array<{ image: number; result: ReviewResult }> = [];
      let active = 0;
      let peak = 0;
      const lease: ReviewLease = { analysisId: snapshot.analysisId, runId: snapshot.runId, jobId: 'benchmark-job', workerId: 'benchmark-worker' };
      const start = performance.now();
      const result = await coordinator({
        lease, snapshot, imageCapability,
        repository: {
          loadExecutions: async () => [],
          ensureExecution: async (_lease, _snapshotId, { input }) => {
            const record = { id: randomUUID(), analysisId: snapshot.analysisId, runId: snapshot.runId, snapshotId: snapshot.id, pass: input.pass, imageEvidenceId: input.imageEvidenceId ?? null, result: null, resultHash: null } as ReviewExecutionRecord;
            records.push(record);
            return record;
          },
          startAttempt: async (_lease, id) => ({ id, attemptNumber: 1 }) as never,
          commitAttempt: async (_lease, id, commit) => {
            const record = records.find(item => item.id === id)!;
            if (commit.outcome === 'success' && commit.result) {
              record.result = ReviewResultSchema.parse(commit.result);
              record.resultHash = createHash('sha256').update(JSON.stringify(commit.result)).digest('hex');
            }
          },
        },
        reviewer: () => ({ review: async (input: ReviewInput) => {
          if (input.pass !== 'image') {
            if (input.pass === 'final' && input.priorReviews?.slice(1).map(review => review.imageEvidenceId).join() !== images.map(image => image.evidenceId).join()) throw new Error('Final image order changed.');
            return empty;
          }
          active++;
          peak = Math.max(peak, active);
          const began = performance.now();
          try {
            const review = liveReviewer ? await liveReviewer.review(input) : await new Promise<ReviewResult>(resolve => setTimeout(() => resolve(empty), delayMs));
            const image = images.findIndex(item => item.evidenceId === input.imageEvidenceId);
            imageTimings.push({ image, elapsedMs: performance.now() - began, observations: review.observations.length, warnings: review.warnings.map(warning => warning.code) });
            imageResults.push({ image, result: review });
            return review;
          } finally { active--; }
        } }),
        publication: () => ({} as never),
      }).catch(error => ({ state: error instanceof Error ? error.message : 'failed' }));
      const row = { round: round + 1, variant, wallMs: performance.now() - start, peak, state: result.state, imageTimings, ...(live ? { imageResults } : {}) };
      rows.push(row);
      console.log(JSON.stringify({ round: row.round, variant, wallMs: Math.round(row.wallMs), peak, state: row.state, images: imageTimings.length }));
    }
  }
  const report = {
    mode: live ? 'live-image-calls' : 'deterministic-scheduling-replay', baselineCommit, images: imageCount, rounds,
    model: live ? snapshot.passes.image.model : null, reasoningEffort: live ? snapshot.passes.image.reasoningEffort : null,
    promptHash: live ? snapshot.passes.image.prompt.hash : null, rows,
    limits: 'Text and final are local no-op passes. Repository commits are in memory. Live runs use real authorized private images and the production image adapter; replay runs use fixed delays. Original analyses are read only.',
  };
  const output = value('--output');
  if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (rows.some(row => row.state !== 'complete')) process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
