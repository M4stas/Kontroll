### Task 3: Add the Supabase schema and anonymous access boundary

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/202609120001_initial.sql`
- Create: `supabase/seed.sql`
- Create: `src/config/env.ts`
- Create: `src/server/db/client.ts`
- Create: `src/server/access/tokens.ts`
- Create: `src/server/repositories/analyses.ts`
- Create: `src/server/repositories/evidence.ts`
- Create: `src/server/repositories/jobs.ts`
- Create: `src/server/repositories/research.ts`
- Create: `src/server/storage/uploads.ts`
- Create: `tests/unit/access/tokens.test.ts`
- Create: `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: `createAccessToken(): { raw: string; hash: string }`.
- Produces: `hashAccessToken(raw: string): string`.
- Produces: `AnalysesRepository.create(input): Promise<{ publicId: string }>` and `AnalysesRepository.loadReport(publicId): Promise<AnalysisReport | null>`.
- Produces: durable `analysis_jobs` leasing through SQL function `lease_analysis_job(worker_id text, lease_seconds int)`.

- [ ] **Step 1: Initialize local Supabase and write the token tests**

Run: `npx supabase init`

Then create:

```ts
import { describe, expect, it } from "vitest";
import { createAccessToken, hashAccessToken } from "@/server/access/tokens";

describe("analysis access tokens", () => {
  it("stores only a repeatable hash of a random token", () => {
    const first = createAccessToken();
    const second = createAccessToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.raw).not.toBe(first.hash);
    expect(hashAccessToken(first.raw)).toBe(first.hash);
    expect(first.raw.length).toBeGreaterThanOrEqual(43);
  });
});
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run: `npm run test -- tests/unit/access/tokens.test.ts`

Expected: FAIL because `tokens.ts` does not exist.

- [ ] **Step 3: Implement token generation and environment validation**

Use `randomBytes(32).toString("base64url")` and SHA-256. Validate these server-only variables in `src/config/env.ts`:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANALYSIS_COOKIE_SECRET
AUTO24_FETCH_ENABLED
OPENAI_API_KEY
OPENAI_INSIGHT_MODEL
WORKER_ID
```

`OPENAI_API_KEY` and `OPENAI_INSIGHT_MODEL` are optional because the baseline must run without Luna. The service-role key must never be exposed through a `NEXT_PUBLIC_` variable.

- [ ] **Step 4: Write the initial migration**

Create the tables from the spec with UUID primary keys and foreign keys:

```sql
create type analysis_status as enum ('queued', 'running', 'partial', 'complete', 'failed');
create type stage_status as enum ('queued', 'running', 'complete', 'unavailable', 'failed');
create type verification_state as enum ('unverified', 'corroborated', 'official', 'contradicted', 'not_checked');
create type job_status as enum ('queued', 'leased', 'complete', 'failed');

create table analyses (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  access_token_hash text not null,
  locale text not null check (locale in ('et', 'en')),
  status analysis_status not null default 'queued',
  current_run_id uuid,
  verdict text check (verdict in ('worth_viewing', 'proceed_cautiously', 'likely_skip')),
  confidence text check (confidence in ('low', 'moderate', 'high')),
  owner_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table analysis_runs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references analyses(id) on delete cascade,
  trigger text not null check (trigger in ('initial', 'supplement')),
  status analysis_status not null default 'queued',
  stage_states jsonb not null default '{}'::jsonb,
  failure jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table analyses
  add constraint analyses_current_run_fk
  foreign key (current_run_id) references analysis_runs(id);
```

Create the remaining tables with these required columns:

- `analysis_inputs`: `id`, `analysis_id`, `listing_url`, `input_type`, `pasted_text`, `vin`, `registration_plate`, `created_at`.
- `source_snapshots`: `id`, `analysis_id`, `run_id`, `source_type`, `source_url`, `captured_at`, `content_hash`, `storage_key`, `extraction_status`, `metadata`.
- `vehicle_facts`: `id`, `analysis_id`, `run_id`, `fact_key`, `fact_value`, `normalized_value`, `source_snapshot_id`, `verification`, `match_confidence`, `created_at`.
- `evidence`: `id`, `analysis_id`, `run_id`, `source_snapshot_id`, `source_class`, `claim`, `applicability`, `confidence`, `captured_at`.
- `findings`: `id`, `analysis_id`, `run_id`, `category`, `severity`, `state`, `title`, `explanation`, `next_action`, `origin`, `created_at`.
- `finding_evidence`: `finding_id`, `evidence_id`, `relation`, with a composite primary key on both IDs.
- `actions`: `id`, `analysis_id`, `run_id`, `kind`, `title`, `instructions`, `status`, `finding_id`, `created_at`.
- `submissions`: `id`, `analysis_id`, `run_id`, `kind`, `provided_by`, `text_content`, `storage_key`, `mime_type`, `idempotency_key`, `created_at`.
- `vehicle_research_cache`: `id`, `cache_key`, `make`, `model`, `generation`, `engine`, `gearbox`, `year_range`, `mileage_band`, `result`, `source_refs`, `schema_version`, `fetched_at`, `expires_at`.
- `analysis_jobs`: `id`, `analysis_id`, `run_id`, `stage`, `status`, `attempts`, `leased_by`, `lease_expires_at`, `available_at`, `last_error`, `idempotency_key`, `created_at`, `completed_at`.

Use foreign keys with `on delete cascade` for analysis-owned rows. Reference `auth.users(id)` from `analyses.owner_id` with `on delete set null`. Add unique constraints on `submissions.idempotency_key`, `analysis_jobs.idempotency_key`, and `(analysis_id, run_id, stage)`. Add checks for confidence values in `0..1`, allowed action kinds, allowed finding states and severities, and non-empty finding titles.

Enable RLS on every table without public select or write policies. Create private Storage bucket `analysis-uploads`. Add `lease_analysis_job` using `for update skip locked`, a lease expiry timestamp, and attempt increment so only one worker receives a job.

Add a `create_analysis` SQL function that inserts the analysis, input, initial run, and first job in one transaction and returns `public_id` plus `run_id`. Grant execution only to the service role.

- [ ] **Step 5: Add repository integration tests**

Test that:

1. An analysis and initial run are created in one use case.
2. Only the hash is persisted.
3. Two lease calls cannot return the same job.
4. An expired lease becomes available again.
5. Anonymous Supabase credentials cannot select `analyses`.

Run:

```bash
npx supabase start
npx supabase db reset
npm run test:integration -- tests/integration/schema.test.ts
```

Expected: the five integration cases pass.

- [ ] **Step 6: Implement repositories and private storage helpers**

Keep the Supabase client server-only. Repositories return domain types, not generated database rows. `uploads.ts` accepts only JPEG, PNG, WebP, and PDF; enforce 12 MB per file and generate signed read URLs with a 10-minute lifetime.

- [ ] **Step 7: Run repository verification**

Run:

```bash
npm run test -- tests/unit/access
npm run test:integration -- tests/integration/schema.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add supabase src/config/env.ts src/server tests/unit/access tests/integration/schema.test.ts .env.example
git commit -m "feat(storage): add private analysis persistence"
```

---

