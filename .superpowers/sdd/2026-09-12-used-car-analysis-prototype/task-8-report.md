# Task 8 report: source policy and reusable vehicle research cache

## Status

Implemented and verified on `codex/used-car-prototype`. Task 8 comprises:

- `725db0c feat(research): add source policy and cache`
- `9295ce6 fix(research): enforce cache contract`
- `dec7d5c fix(research): keep forum recalls as leads`

The unrelated untracked `tests/unit/.DS_Store` was preserved and was never staged.

## Implemented behavior

### Cache key and expiry policy

- `src/research/cache-key.ts` defines `ResearchClaimKind`, `ResearchKey`, `buildResearchKey`, and `cacheExpiryAt`.
- Keys deterministically canonicalize make, model, generation, exact engine, gearbox, stable identified-year range, and 50,000 km mileage band.
- A missing make, model, or valid normalized year returns `null` rather than creating a broad cache entry.
- The cache identity contains the claim kind, so recall and common-issue TTL domains cannot overwrite one another.
- Recall entries expire after 30 days; common-issue summaries expire after 90 days.

### Source policy and official links

- `src/research/source-policy.ts` ranks registry sources first for identity/history, manufacturers first for recalls/maintenance, independent sources first for repair context, and sends forums to background and listing/seller/buyer material to unverified input.
- Recall evidence is `exact` only when a normalized VIN exists and the source reports a VIN match; otherwise it remains `needs_confirmation`.
- Forum material is always background, including a forum post that asserts a VIN match, so it cannot become recall confirmation.
- `src/research/official-links.ts` exposes only plain outbound links: the required MNT checker plus the specified BMW Group, Volkswagen, and Volvo pages. Volkswagen and Volvo links carry their US-market limitation. Unknown makes have no fabricated link.
- The MNT record is always returned as `not_checked` and `manual_only`; there is no endpoint call, scraping, or CAPTCHA bypass.

### Provider and repository-backed cache

- `src/research/provider.ts` exposes the requested `ResearchProvider.research(vehicle)` interface and normalized research/source-reference contracts.
- `CachedResearchProvider` checks a fresh repository entry before calling its upstream provider, then stores result, URLs, retrieval timestamp, applicability, schema version, and policy expiry.
- A cache hit must match every normalized dimension, including engine, and the current schema version. Thus engine-specific material and incompatible stored result shapes are not reused.

## Files

- Added: `src/research/cache-key.ts`
- Added: `src/research/source-policy.ts`
- Added: `src/research/official-links.ts`
- Added: `src/research/provider.ts`
- Added: `tests/unit/research/cache-key.test.ts`
- Added: `tests/unit/research/source-policy.test.ts`
- Added: `tests/integration/research-cache.test.ts`

## Test-first evidence

The original Task 8 commit existed when this task was taken over. Its pre-implementation red-run output cannot be reconstructed from Git, and no prior Task 8 report was present.

The takeover amendments used observed red/green cycles:

1. Added integration tests for rejecting a fresh-but-different schema result and invoking upstream with only the one-argument provider contract. The first attempted test seed used schema version `0` and correctly hit the database schema constraint; it was corrected to valid version `2`. The intended red run then failed with the legacy result returned and with the extra `common_issue` argument observed. After the provider/cache-match change, the integration suite passed.
2. Added a unit test for a forum recall claim with `vinMatched: true`. It failed with received `exact` where `background` was required. Moving the forum classification ahead of recall confirmation made it pass.

## Verification

All commands ran from `~/cars/.worktrees/used-car-prototype` after the final code commit:

```text
npm run test -- tests/unit/research
PASS: 2 files, 13 tests

npm run test:integration -- tests/integration/research-cache.test.ts
PASS: 3 matched integration files, 19 tests (local Docker Supabase)

npm run test
PASS: 19 files, 128 tests

npm run typecheck
PASS: exit 0

npm run lint
PASS: exit 0

git diff --check e4d156c..HEAD
PASS: no whitespace errors
```

## Self-review

Reviewed the complete Task 8 range `e4d156c..dec7d5c`, including all research modules and their unit/integration tests. The review found and corrected two Task 8 defects: the upstream provider contract was widened with a second argument, and forum recall claims could bypass the leads-only policy. It also added schema-version matching so a fresh but incompatible stored result is not reused. The final review found no remaining actionable Task 8 issues.

## Concerns and deliberately deferred work

- There is intentionally no live web, OpenAI/Luna, worker, or report UI integration in this task.
- The MNT check remains a manual outbound link and `not_checked` until a compliant result or buyer-provided record is supplied by later work.
- Manufacturer links are a deliberately small curated set; unlisted makes return no link.

## Fix round 1

Commit: `ff90a2a fix(research): preserve evidence applicability`.

### Changes

- Added one compatibility gate before recall VIN applicability. Every supplied make, model, generation, engine, gearbox, and year range must match the normalized vehicle; a mismatch produces `background` rather than an exact recall.
- Added safe inclusive parsing for one-year and `start-end` year ranges. Invalid, reversed, or unresolved ranges cannot qualify evidence.
- Bound a `CachedResearchProvider` instance to its claim kind at construction, made it implement `ResearchProvider`, and restored the public `research(vehicle): Promise<VehicleResearch>` contract. When cache identity is unresolved, it returns upstream research without caching instead of `null`.
- Expanded policy coverage for each conflicting identity dimension and for matching-engine sources with incompatible generation, gearbox, and year. Expanded cache integration coverage for the one-argument interface, recall cache selection, and unresolved identity fallback.

### Test-first evidence

1. The added source-policy tests initially failed twice: conflicting recall metadata returned `exact`, and engine-matched evidence returned `exact` despite supplied technical conflicts.
2. The amended integration test initially failed in all five cache cases with `TypeError: this.now is not a function`, demonstrating that the old constructor/method shape could not serve the new one-argument public contract.
3. After the implementation, focused unit and integration tests passed. The first full typecheck exposed `year` as possibly undefined in the new helper; a local narrowing fixed that error, followed by green verification.

### Verification

All commands ran from `~/cars/.worktrees/used-car-prototype`:

```text
npm run test -- tests/unit/research/source-policy.test.ts
RED: 2 expected assertion failures; GREEN: 1 file, 9 tests

npm run test:integration -- tests/integration/research-cache.test.ts
RED: 5 provider-contract failures; GREEN: 3 matched integration files, 20 tests

npm run test -- tests/unit/research
PASS: 2 files, 20 tests

npm run test:integration -- tests/integration/research-cache.test.ts
PASS: 3 matched integration files, 20 tests (local Docker Supabase)

npm run typecheck
PASS: exit 0

git diff --check
PASS: no whitespace errors
```

### Self-review

Reviewed `ff90a2a^..ff90a2a` against all three findings. The identity gate precedes VIN confirmation and checks every declared dimension; engine/gearbox return paths occur only after that gate; the cache decorator formally implements the one-argument provider interface and cannot return `null`. No remaining actionable issues found. `tests/unit/.DS_Store` remains untracked and unstaged.
