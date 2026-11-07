import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { createWorkerLease, parseWorkerArgs } from '@/worker/created-after';

it('rejects invalid or missing cutoff before worker startup', () => {
  expect(() => parseWorkerArgs(['--created-after'])).toThrow();
  expect(() => parseWorkerArgs(['--created-after', 'yesterday'])).toThrow();
  expect(parseWorkerArgs([])).toBeUndefined();
  expect(parseWorkerArgs(['--created-after', '2026-10-05T08:14:00Z'])).toBe('2026-10-05T08:14:00.000Z');
  expect(() => parseWorkerArgs(['--since', '2026-10-05T08:14:00Z'])).toThrow('Usage: pnpm worker');
  expect(() => parseWorkerArgs(['--created-after', '2026-10-05T08:14:00'])).toThrow();
});

it('normalizes an offset cutoff to the same instant in UTC', () => {
  // ISO 8601: 11:14 at +03:00 (Estonian summer time) is 08:14 UTC.
  expect(parseWorkerArgs(['--created-after', '2026-10-05T11:14:00+03:00'])).toBe('2026-10-05T08:14:00.000Z');
});

it('leases current and future reports while excluding older analyses with newer jobs', async () => {
  const eligible = [
    { analysis_id: 'older', created_at: '2026-10-04T00:00:00Z' },
    { analysis_id: 'current', created_at: '2026-10-05T08:14:22Z' },
    { analysis_id: 'future', created_at: '2026-10-06T00:00:00Z' },
  ];
  const leased: string[] = [];
  const client = createClient('http://worker.test', 'key', { global: { fetch: async (input) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/rest/v1/analysis_jobs');
    expect(url.searchParams.get('select')).toContain('analyses!inner');
    const cutoff = url.searchParams.get('analyses.created_at');
    expect(cutoff).toBe('gte.2026-10-05T08:14:00.000Z');
    expect(url.searchParams.get('available_at')).toMatch(/^lte\./);
    expect(url.searchParams.get('or')).toContain('lease_expires_at.lte.');
    return new Response(JSON.stringify(eligible.filter(row => row.created_at >= cutoff!.slice(4))), { headers: { 'Content-Type': 'application/json' } });
  } } });
  const lease = createWorkerLease(client, {
    lease: async () => { throw new Error('unscoped lease must not run'); },
    leaseForAnalysis: async (_worker, _seconds, analysisId) => { leased.push(analysisId); return null; },
  }, '2026-10-05T08:14:00.000Z');
  await lease('worker', 60);
  expect(leased).toEqual(['current', 'future']);
});

it('retains the existing general worker when no cutoff is provided', async () => {
  const client = createClient('http://worker.test', 'key');
  let calls = 0;
  const lease = createWorkerLease(client, {
    lease: async () => { calls++; return null; },
    leaseForAnalysis: async () => { throw new Error('unexpected scoped lease'); },
  });
  await lease('worker', 60);
  expect(calls).toBe(1);
});

it('advances past a full page of dependency-blocked reports', async () => {
  const client = createClient('http://worker.test', 'key', { global: { fetch: async (input) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('offset'));
    const rows = offset === 0
      ? Array.from({ length: 32 }, (_, i) => ({ analysis_id: `blocked-${i}` }))
      : [{ analysis_id: 'ready' }];
    return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
  } } });
  const ready = { id: 'ready-job' } as Awaited<ReturnType<import('@/server/repositories/jobs').JobsRepository['lease']>>;
  const lease = createWorkerLease(client, {
    lease: async () => { throw new Error('unexpected general lease'); },
    leaseForAnalysis: async (_worker, _seconds, id) => id === 'ready' ? ready : null,
  }, '2026-10-05T08:14:00.000Z');
  expect(await lease('worker', 60)).toBeNull();
  expect(await lease('worker', 60)).toBe(ready);
  expect(await lease('worker', 60)).toBeNull();
});

it('surfaces database lookup failure instead of falling back to the general queue', async () => {
  const client = createClient('http://worker.test', 'key', { global: { fetch: async () =>
    new Response(JSON.stringify({ message: 'lookup failed' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  } });
  const lease = createWorkerLease(client, {
    lease: async () => { throw new Error('unexpected general lease'); },
    leaseForAnalysis: async () => { throw new Error('unexpected scoped lease'); },
  }, '2026-10-05T08:14:00.000Z');
  await expect(lease('worker', 60)).rejects.toThrow('Could not find scoped analysis jobs');
});
