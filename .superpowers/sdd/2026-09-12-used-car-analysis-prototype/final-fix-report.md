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

## Continued consolidated wave — verified partial slice (2026-09-25)

The prior uncommitted pipeline, research, migration, and test edits were retained and completed as one scoped change. No prior worktree edits were reset or discarded. The additive migration defines service-role-only RPCs for research evidence and enrichment source snapshots, preserving producer-stage and run ownership. A local integration case verifies research evidence replacement leaves enrichment citations intact and anonymous RPC use fails. `npx supabase migration up --local` reported no pending migrations; the integration suite exercised the functions in the existing local database. A clean reset was not performed.

- **Critical 2, partial:** The real stage pipeline now reaches `likely_skip` for two confirmed listing contradictions, `proceed_cautiously` for unresolved checks, and `worth_viewing` when the listed inspection views are classified and no important finding remains. Listing image labels are seller-provided coverage indicators, not proof of image contents or condition. NHTSA VIN decoding raises identity confidence only when make, model, year, VIN, exact URL class, and freshness align. This allows moderate confidence; confidence remains capped below high for VIN identity and labeled listing images alone. A trustworthy production path to high confidence still needs independently verified condition/history coverage. No check of Estonian history, recalls, common faults, maintenance, or the actual car is implied by VIN decoding.
- **Important 3:** Accepted Luna source IDs are mapped to run-scoped source snapshots and unverified evidence before assembly. The original URL, source class, applicability proposal, and source observation are retained. A full pipeline test uses the real `LunaInsightProvider` contract and verifies an important source-citing finding survives assembly. Invalid citation URLs cannot be registered as evidence.
- **Important 5, partial:** Deterministic baseline findings and actions are generated in ET for an ET run, and the copied seller request contains ET instructions. The NHTSA identity-only source label, claim, and limitation are localized. Original seller claims remain untouched. Optional Luna-generated findings/actions and some generated evidence explanations still need locale handling and source-language metadata; the seeded browser report remains English in its content despite ET chrome.
- **Important 6, partial:** The production worker now composes a VIN-scoped `CachedResearchProvider` backed by the bounded NHTSA vPIC decode. Cache tests cover reuse for one VIN, isolation across VINs, and no-network unavailability without a VIN. The response is rejected if its VIN is absent or mismatched. The Estonian Transport Administration remains `not_checked`. This is identity research only; compliant model-specific issue and recall sources have not been integrated, so full applicable-source research and Luna-cost reduction are not demonstrated.
- **Important 7:** No PDF text extraction or document review was implemented in this slice. PDF supplements remain private and unverified, but cannot yet corroborate a maintenance claim.

### Verification and review

- Focused TDD red/green was observed for ET deterministic copy, preventing high confidence from seller image labels, and rejecting a VIN decode with no returned VIN. The prior uncommitted tests for verdict reachability, cache scope, and Luna source persistence were retained and expanded.
- Final full gate: `npm test` 272/272, `npm run test:integration` 55/55, `npm run test:e2e` 4/4, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. The initial sandboxed unit run hit the known `tsx` local pipe `EPERM`; the permitted full rerun passed. The four browser tests exercise seeded reports and do not establish the real fallback browser journey. The build emitted the existing Next.js middleware deprecation advisory.
- Inline self-review checked run/source ownership, source verification labels, the VIN response contract, confidence policy, and preservation of source excerpts. No subagent was used, as explicitly requested. No push or PR edit was made.

### Remaining scope before this is merge-ready

1. Implement bounded PDF extraction/review tied to the private upload and accepting run. Keep unreadable/scanned PDFs explicitly unverified; test a real PDF supplement through the worker.
2. Add compliant, applicable background/recall/model research beyond VIN identity. Cache by the right vehicle scope, preserve source freshness and applicability, and continue to show blocked sources as `not_checked`.
3. Finish ET coverage for optional insight-generated analysis and generated evidence explanations without translating source excerpts as if they were verified summaries. Test the copied message with actual ET pipeline output in a browser.
4. Add real-worker browser journeys for disabled and blocked Auto24 capture, buyer paste and screenshots, private access, and desktop/mobile screenshots and manual QA. Existing E2E cases use seeded reports.
5. Establish a defensible route to high confidence using independent evidence; do not promote VIN identity or seller-provided image labels to a vehicle-condition check. Complete final review and rerun all gates after the remaining work. Existing PR was left untouched.
