import { it, expect, vi } from 'vitest';
import { parseApplicationEnv, parseWorkerEnv } from '@/config/application';
import { getServerEnv } from '@/config/env';
const raw = { NEXT_PUBLIC_SUPABASE_URL: 'https://storage.example', SUPABASE_SERVICE_ROLE_KEY: 'secret', ANALYSIS_COOKIE_SECRET: 'secret-that-is-at-least-32-characters', DATA_REVIEW_MODE: 'invalid', WORKER_ID: 'worker' };
it('app and worker share mandatory parsing independently of reviewer errors', () => {
    expect(parseWorkerEnv(raw)).toEqual({ ...parseApplicationEnv(raw), WORKER_ID: 'worker' });
    const withoutWorker = { ...raw, WORKER_ID: undefined };
    expect(() => parseApplicationEnv(withoutWorker)).not.toThrow();
    expect(() => parseWorkerEnv(withoutWorker)).toThrow();
});
it('Next wrapper and worker pure parser resolve the same explicit environment', () => {
    for (const [key, value] of Object.entries(raw))
        vi.stubEnv(key, value);
    expect(getServerEnv()).toEqual(parseApplicationEnv(process.env));
    vi.unstubAllEnvs();
});
