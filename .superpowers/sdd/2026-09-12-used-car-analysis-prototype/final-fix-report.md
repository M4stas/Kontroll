# Consolidated fix wave — partial handoff

Date: 2026-09-25. Base: `50419b5` on `codex/used-car-prototype`.

## Implemented in this wave

- Critical 1: Added explicit buyer-pasted listing text at creation and in the private report supplement form. The authenticated supplement path accepts buyer screenshots separately from seller files, stores buyer provenance, and selects capture, normalization, baseline, research, enrichment, and assembly for the new run. Fallback capture retains the original URL, uses the most recent buyer text, extracts bounded labeled facts, and carries screenshot references. Screenshot capabilities can be sent to optional image enrichment. Baseline evidence derived from fallback is labeled buyer input. An arbitrary screenshot or service-book image reference no longer clears the unverified no-investment claim.
  Superseded pasted text remains in audit evidence but is excluded from the current fallback's claim checks.
- Important 4: `loadRunContext` now selects and checks each submission's accepting `run_id`, preserving IDs across later runs.
- Minor 1: `suurhooldus` now triggers the maintenance-document request.
- Task14 UX: A report API 401/403 now settles on a localized private-access message after hydration. The existing browser journey now asserts this state.

## Verification

- TDD red/green confirmed for fallback fact extraction, creation persistence, later buyer submission and stage selection, settled no-access state, Estonian compound maintenance wording, and screenshot maintenance-claim handling.
- `npm test`: 256 passed after the final superseded-text regression.
- `npm run test:integration`: 54 passed, including run lineage assertion.
- `npm run test:e2e`: 4 passed after the denied-access assertion was updated. These browser cases use seeded report data; there is no new real worker fallback browser case in this wave.
- `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`: passed. The build emitted the existing Next.js middleware deprecation advisory.
- One sandboxed unit run failed because `tsx` could not open its local pipe; the permitted full rerun passed. One sandboxed integration run failed because Supabase CLI could not write telemetry; the permitted full rerun passed. Typecheck and build were initially run concurrently, causing transient missing `.next/types` errors; sequential typecheck passed.
- Inline self-review caught and corrected false maintenance reassurance from screenshot and image references. No subagents were spawned, as requested.

## Remaining review scope

1. **Critical 2:** Real worker stages still cannot reach all three verdicts and confidence bands safely. The unconditional open `missing_inspection_images` finding and low confidence floor remain. Do not claim verdict compliance from seeded report tests. This needs classified image coverage, a defensible corroboration/confirmation path, and full-pipeline tests for all verdicts and bands.
2. **Important 3:** Luna source IDs are still dropped before evidence persistence, so source-citing important/critical findings can be removed at assembly.
3. **Important 5:** Deterministic finding/action text and copied seller instructions remain English in ET reports.
4. **Important 6:** The production worker still has no cached research provider or applicable upstream source strategy.
5. **Important 7:** PDFs are still stored and labeled unverified but not text-extracted or reviewed.
6. Add a real worker/browser fallback journey with disabled and blocked Auto24 capture, including screenshots, to complement the current unit and seeded E2E tests. Manual desktop and mobile QA of this new journey remains outstanding.

This is a safe partial commit, not a completed final fix wave or merge-ready result. No push or PR edit was made.
