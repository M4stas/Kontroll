import { z } from 'zod';
const applicationSchema = z.object({ NEXT_PUBLIC_SUPABASE_URL: z.url(), SUPABASE_SERVICE_ROLE_KEY: z.string().min(1), ANALYSIS_COOKIE_SECRET: z.string().min(32), AUTO24_FETCH_ENABLED: z.enum(['true', 'false']).default('true').transform(value => value === 'true') });
export function parseApplicationEnv(raw: Record<string, string | undefined>) { return applicationSchema.parse(raw); }
export function parseWorkerEnv(raw: Record<string, string | undefined>) { return { ...parseApplicationEnv(raw), WORKER_ID: z.string().trim().min(1).parse(raw.WORKER_ID) }; }
