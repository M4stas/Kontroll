# Task 9 report: optional schema-constrained Luna enrichment

## Status

Implemented optional, failure-isolated Luna enrichment on `codex/used-car-prototype`.

## Files changed

- Added `src/insights/provider.ts`: versioned contracts, strict Zod schemas, generated JSON Schema, and optional environment factory.
- Added `src/insights/prompt.ts`: Responses API text/image input construction, untrusted-data delimiting, and signed-private/current-analysis image filtering.
- Added `src/insights/luna.ts`: OpenAI Responses API boundary with `high` reasoning, web search, strict structured output, 75-second abort, refusal detection, and warning-only degradation.
- Added `tests/unit/insights/luna.test.ts` and `tests/fixtures/insight-response.json`.
- Changed `src/research/source-policy.ts` only to export the existing applicability values as the single runtime source for the new Zod enum. This prevents duplicate applicability enums; policy behavior is unchanged.

`.env.example` already supplied the required optional variables, so its contract was not amended. The unrelated untracked `tests/unit/.DS_Store` remains preserved and unstaged.

## TDD evidence

Each test names the production break it catches: evidence-free findings, prompt injection handling, invalid/cross-analysis images, timeout, refusal, malformed/schema-invalid output, incomplete environment configuration, and incomplete image observations.

```text
RED
npm run test -- tests/unit/insights
FAIL: 1 suite, 0 tests. Expected import-resolution failure: `@/insights/provider` did not exist.

GREEN
npm run test -- tests/unit/insights
PASS: 1 file, 9 tests.

npm run typecheck
PASS: exit 0.
```

The first post-implementation focused run exposed a missing-output guard in the fake Responses result, a browser-style fixture URL in Vitest, and an OpenAI constructor restriction in jsdom. The provider now treats absent output safely; the fixture uses a filesystem path; and only the external OpenAI constructor is mocked. A subsequent typecheck caught an incomplete normalized-vehicle fixture; it was made a complete `InsightInput` fixture before the green rerun.

## Final verification

All commands ran from `~/cars/.worktrees/used-car-prototype` after the final edit:

```text
npm run typecheck
PASS: exit 0

npm run test
PASS: 20 files, 144 tests

npm run lint
PASS: exit 0

git diff --check ff90a2a --
PASS: no whitespace errors
```

## Self-review

Reviewed the complete Task 9 diff directly, as the request explicitly prohibited subagents. Checked the generated strict JSON schema and Zod parser; required source, finding, action, warning, and image-observation fields; dynamic evidence/source/image-reference validation; the installed `openai@^7.15.0` Responses request and abort-signal shape; model preservation; all untrusted-content boundaries; and all warning-only failure paths. No actionable issues found.

## Concerns and deliberate scope limits

- This task intentionally does not connect Luna to the worker, report assembler, UI, persistence, or live research.
- A signed URL is accepted only when the caller supplies explicit private/signed/current-analysis provenance. Upstream storage issuance must provide that contract in a later task.
- Tests make no live OpenAI call; they mock only the external OpenAI boundary.

## Fix round 1

### Changes

- Required an `InsightSource` directly on every finding and image observation. The runtime also requires that source to resolve, field-for-field, to one unique entry in the result source list. Findings must cite their own provenance source as evidence; image observations now require a recommended action.
- Replaced caller-controlled image URL/access flags with an opaque capability and a narrow injected `InsightImageUrlVerifier`. The provider is fail-closed if no verifier is configured. For every verified capability it independently validates HTTPS, a configured storage origin, future expiry, matching analysis and evidence IDs, and an analysis-scoped storage key.
- Added an untrusted evidence-ID label immediately before each accepted `input_image`, so a multi-image response can unambiguously cite the supplied ID.
- Extended the response fixture and unit coverage for source-less findings, valid two-image observations, labels, forged capabilities, cross-analysis capabilities, expired capabilities, and disallowed origins.

The existing `AnalysisUploads` seam produces private signed read URLs but cannot validate an opaque Supabase signature later in the pipeline. This fix therefore uses the allowed narrow verifier injection rather than introducing duplicate signing or persistence logic. A future server-side orchestrator must supply that verifier from the storage issuance boundary.

### Test-first evidence

```text
RED
npm run test -- tests/unit/insights/luna.test.ts
FAIL: 1 file, 12 tests; 4 expected failures.
- Source provenance from the amended fixture was discarded.
- A source-less finding was accepted.
- Valid capability-backed multi-image observations were rejected.
- Caller-controlled forged URL/access flags reached the request.

GREEN
npm run test -- tests/unit/insights/luna.test.ts
PASS: 1 file, 12 tests

npm run typecheck
PASS: exit 0

npm run test -- tests/unit/insights
PASS: 1 file, 12 tests
```

### Self-review

Reviewed `8bedfe8..working tree` directly, as subagents remain prohibited. Checked direct and resolvable provenance for both proposal classes, strict schema additions, source/evidence cross-checks, per-image label ordering, verifier failure closure, and every required image rejection gate. `git diff --check 8bedfe8 --` reported no whitespace errors. No actionable issues found. `tests/unit/.DS_Store` remains untracked and unstaged.

## Fix round 2

### Changes

- Extended `createInsightProvider(env, imageBoundary?)` to carry a trusted verifier, allowed origins, and clock into the normally constructed Luna provider while preserving `null` when either optional OpenAI variable is absent.
- Moved capability verification and request construction into `LunaInsightProvider.enrich`’s existing failure boundary. A malformed/throwing verifier now yields the same warning-only, no-findings `request_failed` result as other optional enrichment failures.

### Test-first evidence

```text
RED
npm run test -- tests/unit/insights/luna.test.ts
FAIL: 1 file, 14 tests; 2 expected failures.
- Factory-supplied verification did not put the issued image/evidence label into the Responses request.
- A throwing verifier rejected with `Error: Malformed capability` instead of returning a warning-only result.

GREEN
npm run test -- tests/unit/insights/luna.test.ts
PASS: 1 file, 14 tests

npm run test -- tests/unit/insights
PASS: 1 file, 14 tests

npm run typecheck
PASS: exit 0
```

### Self-review

Reviewed only `2b560a0..working tree`. Verified factory option forwarding, unchanged optional-environment null behavior, and that all image verification and request construction now execute inside the warning-only `try` boundary. `git diff --check 2b560a0 --` reported no whitespace errors. No actionable issues found; `tests/unit/.DS_Store` remains untracked and unstaged.
