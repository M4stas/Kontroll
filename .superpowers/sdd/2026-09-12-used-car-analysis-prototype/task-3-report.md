# Task 3 verification report

## Status

VERIFIED WITH FIX for original Task 3 commit `c1e4acd12def67c19f1d652707776e44c339a929`. Verification found one repository defect, fixed by `55b82ef` (`fix(storage): persist finding evidence relation`).

## Exact command summaries

1. `npx supabase db reset` — exit 0. Applied `202609120001_initial.sql`, seeded `supabase/seed.sql`, restarted containers, and printed `Finished supabase db reset on branch main.` plus `Reset local database.`
2. `npm run test -- tests/unit/access tests/unit/storage` — exit 0: 2 test files passed, 5 tests passed, duration 665 ms.
3. `npm run test:integration -- tests/integration/schema.test.ts` — original commit exit 0: 1 test file passed, 5 tests passed, duration 1.87 s. After adding the regression test, RED was 1 failed and 5 passed with PostgreSQL `23502` (`null value in column "relation"`). Final exit 0: 1 test file passed, 6 tests passed, duration 1.79 s.
4. `npm run typecheck` — original commit exit 0. The first regression-test draft exposed test-only `TS2322`; after adding an explicit evidence-ID guard, final exit 0 with no diagnostics.
5. `npm run test` — original commit exit 0: 7 test files passed, 43 tests passed, duration 2.36 s. Final exit 0: 7 test files passed, 44 tests passed, duration 2.26 s.
6. `git diff --stat --patch --find-renames 634dcb3..c1e4acd` — reviewed once: 16 files changed, 1,794 insertions, 1 deletion.

## Changed files in `634dcb3..c1e4acd`

- `src/config/env.ts`
- `src/server/access/tokens.ts`
- `src/server/db/client.ts`
- `src/server/repositories/analyses.ts`
- `src/server/repositories/evidence.ts`
- `src/server/repositories/jobs.ts`
- `src/server/repositories/research.ts`
- `src/server/storage/uploads.ts`
- `supabase/.gitignore`
- `supabase/config.toml`
- `supabase/migrations/202609120001_initial.sql`
- `supabase/seed.sql`
- `tests/integration/schema.test.ts`
- `tests/unit/access/tokens.test.ts`
- `tests/unit/storage/uploads.test.ts`
- `vitest.config.ts`

Fix commit `55b82ef` changes `src/server/repositories/evidence.ts` and `tests/integration/schema.test.ts`.

## TDD provenance

The original Task 3 implementation and tests are combined in one commit, so repository history does not independently prove that its tests were observed failing before implementation. The verification fix followed an observed red/green cycle: the new real-database integration case failed with 1/6 tests on the missing non-null `relation`; after the one-field repository fix it passed 6/6. The test-only TypeScript guard was then added in response to an observed `TS2322` typecheck failure.

## Self-review

- SQL/schema: required enums, 12 tables, UUID keys, analysis-owned cascading foreign keys, owner `auth.users` set-null reference, uniqueness rules, confidence/action/finding checks, transactional `create_analysis`, and skip-locked expiring job leases are present.
- RLS/grants: RLS is enabled on every application table with no public policies. Both security-definer functions revoke execution from `public`, `anon`, and `authenticated`, then grant only `service_role`.
- Tokens/environment: tokens use 32 random bytes encoded as base64url and SHA-256 hashes; server environment validation includes all required variables, keeps the service-role key server-only, and leaves OpenAI configuration optional.
- Storage: `analysis-uploads` is private, limited to JPEG/PNG/WebP/PDF and 12 MiB; the helper checks declared and detected content types and creates 600-second signed URLs.
- Repositories: analysis creation/report mapping, evidence, jobs, research cache, and storage helpers return application-facing types. Review found that finding-evidence links omitted their required relation; `55b82ef` now persists `supports` and covers the real database behavior.

## Concerns / completion boundary

No remaining Task 3 defect was found by the requested checks and self-review. A separate subagent review, manual desktop/mobile E2E testing, and pull request were explicitly outside this verification run; therefore the global production-completion gate is not claimed.

---

# Fix round 1

## Status and commit

PASS. Important review findings 1–4 are fixed in commit `651ed268bb4c913971860321771eec6a492f653d` (`fix(storage): secure persistence ownership boundaries`).

## Changes

- Added forward migration `supabase/migrations/202609120002_task3_review_round1.sql` with service-role-only `renew_analysis_job`, `complete_analysis_job`, `retry_analysis_job`, `fail_analysis_job`, and transactional `save_findings` RPCs.
- Job transitions now require job ID, current worker ID, `leased` state, and an unexpired lease; no-match transitions raise an error. Renew duration is restricted to 1–3600 seconds.
- `JobsRepository` now passes worker ownership to every transition and rejects SQL errors or empty RPC results.
- `EvidenceRepository.saveFindings` now sends findings and typed `supports`/`contradicts` links through one transactional RPC.
- Upload and signed-read helpers validate analysis UUIDs. Signed reads require the authorized analysis ID and reject keys outside its exact `<analysisId>/` prefix before storage is called.
- Restored `vitest.config.ts` to unit-only discovery and added `vitest.integration.config.ts`; `test:integration` explicitly uses the integration config.

## TDD evidence

- Storage RED: `npm run test -- tests/unit/storage` exited 1 with 1 file failed; 3 tests failed and 3 passed. Failures proved non-UUID uploads were accepted, the signer used the analysis ID as the object key, and cross-analysis keys were signed.
- Integration RED: `npm run test:integration -- tests/integration/schema.test.ts` exited 1 with 1 file failed; 5 tests failed and 5 passed. Failures showed split finding writes left 1 partial finding, stale renew resolved successfully, old job method signatures failed current-worker behavior, and renew accepted invalid durations.
- First GREEN pass: storage reached 6/6. Integration reached 9/10; its only remaining failure was timestamp representation (`Z` expected versus PostgreSQL `+00:00` received). After comparing normalized instants, integration reached 10/10.
- Self-review added direct expired-owner and anonymous-RPC denial coverage; final integration result is 12/12.

## Exact final command/output summaries

1. `npx supabase db reset` — exit 0. Output applied `202609120001_initial.sql` and `202609120002_task3_review_round1.sql`, seeded `supabase/seed.sql`, restarted containers, printed `Finished supabase db reset on branch main.`, and returned `Reset local database.`
2. `npm run test -- tests/unit/access tests/unit/storage` — exit 0: `Test Files  2 passed (2)`; `Tests  7 passed (7)`; `Duration  689ms`.
3. `npm run test:integration -- tests/integration/schema.test.ts` — exit 0 using `vitest.integration.config.ts`: `Test Files  1 passed (1)`; `Tests  12 passed (12)`; `Duration  1.85s`. Output also listed the stopped optional local Supabase services.
4. `npm run typecheck` — exit 0; `tsc --noEmit` produced no diagnostics.
5. `npm run test` — exit 0 with unit-only discovery: `Test Files  6 passed (6)`; `Tests  40 passed (40)`; `Duration  765ms`.

## Exact fix diff self-review

Reviewed commit `651ed26` with `git show --stat --patch --find-renames --format=fuller 651ed26`: 9 files changed, 556 insertions, 80 deletions. No Important finding remains in the fix diff.

- Ownership checks are performed atomically in each SQL `update` predicate; stale, expired, non-leased, wrong-worker, and missing jobs cannot transition.
- Renew validates both worker identity and a 1–3600 second duration before updating.
- Every new RPC revokes execution from `public`, `anon`, and `authenticated`, then grants only `service_role`; anonymous denial is covered against all five RPCs.
- Finding and link inserts share one function transaction; invalid link input rolls back the finding insert. Successful coverage exercises both allowed relations.
- UUID and exact-prefix checks execute before reading uploads or requesting signed URLs.
- Default `npm test` runs only unit tests; the separate integration command still discovers and runs the schema suite when its path is explicitly passed.

## Concerns / deferred scope

No round-1 Important concern remains. Minor findings were not changed. Per instruction, no subagents were spawned; PR creation and manual E2E remain outside this backend fix round.
