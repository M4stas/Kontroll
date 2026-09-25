# Task 13 report

## Design plan (before coding)

- Inherit the report's inspection-sheet palette: ink navy `#141d29`, blue gray `#202d3d`, off white `#edf1f5`, steel `#abb9c9`, amber `#e8b878`, pale blue `#94bce8`. Keep Arial UI type, existing max-width and two-column report layout.
- Place a compact offline notice immediately before the report header and a 44px minimum-height clear action beside it. Use an amber rule to distinguish stale local data without changing the verdict hierarchy. Use the same treatment for a missing-copy state.
- On authenticated load, fetch `/api/analyses/{publicId}/report` in client code with `cache: no-store`, validate with `AnalysisReportSchema`, and retain only the latest validated report in IndexedDB keyed by public ID. An HTTP denial or malformed response is not an offline fallback. On network failure, read the IDB copy. Persist checklist IDs in the same per-analysis local record.
- Register a TypeScript-authored service worker emitted to `public/sw.js` for development and build. It requests an authenticated shell-only report document that omits the `serverReport` prop and private payload from HTML/RSC, plus same-origin static assets. No API response, upload, signed URL, or error enters Cache Storage. Clearing removes the report record and worker shell/assets.
- The report URL contains only public ID in path. Access tokens remain in the existing cookie/fragment flow and are never used as storage keys or worker messages. IndexedDB retains one latest validated report; `write` replaces the previous report, while `clearCachedReport(id)` deletes only that ID.
- Test report isolation, validation, checklist persistence, offline fallback, clear behavior, and worker cache boundary. Verify English and Estonian copy, keyboard/touch target size, desktop/mobile layout.

Review against brief: the treatment reuses existing report tokens and spacing, adds no new navigation or decorative asset, and preserves the inspection hierarchy.

## Implementation

- `src/features/offline/report-cache.ts`: strict schema and public-ID check; IndexedDB stores one latest report and checklist, replacing an older report on `cacheReport`. `clearCachedReport(id)` deletes only the given ID. No token fields are accepted. Writes resolve on transaction completion.
- `src/features/offline/offline-report.tsx`: network-first private JSON fetch with IndexedDB fallback only for network failure; HTTP denial and malformed JSON never fall back. It shows an offline notice, stale-data explanation, and clear action. Offline viewing suppresses refresh and uploads.
- `src/features/offline/service-worker.ts`, `scripts/build-service-worker.ts`, `public/sw.js`, `src/features/offline/register-worker.tsx`: TypeScript-authored worker and build/dev emission. Worker requests a server-verified shell-only HTML response, caches one report path and successful `/_next/static/` assets, and bypasses API/upload/signed/error responses. Clear deletes shell and asset caches. Offline without a shell returns an uncached localized explanation.
- `src/app/[locale]/a/[publicId]/page.tsx`: after normal cookie verification, recognizes the worker's shell request header and renders the report route without the `serverReport` prop. Its authenticated marker enables shell caching without report payload serialization.
- `src/features/report/viewing-checklist.tsx`, `report-view.tsx`, both message catalogs, `src/app/layout.tsx`, `package.json`, `playwright.config.ts`: checklist persistence, offline presentation and registration, localized copy, build wiring, production E2E server.
- `tests/unit/offline/report-cache.test.ts`, `tests/e2e/analysis.spec.ts`: isolation, latest-only replacement, clearing, validation/token rejection, offline report and checklist, HTTP denial boundary, cache contents, and empty-copy state.

## RED / GREEN evidence

1. RED `npm run test -- tests/unit/offline`: failed to resolve missing `report-cache` module (exit 1). GREEN: 3/3 initial tests; final focused run 25/25 across four files.
2. RED `npm run test:e2e -- tests/e2e/analysis.spec.ts -g 'retains the latest'` with private-claim cache assertion: failed because the cached SSR HTML contained `Service history is claimed but not documented`. GREEN after shell-only rendering: 1/1; full report E2E 2/2.
3. Final `npm run typecheck`, `npm run lint`, `git diff --check`, and standalone `npm run build`: all exit 0. The production build compiled and generated all routes; `next-env.d.ts` has no drift.

## Manual E2E / visual check

- Inspected Playwright screenshots at desktop 1280px and mobile 390px, both online and offline. The amber notice remains above the verdict, the mobile action wraps cleanly, the checked item remains visible, and no horizontal overflow appears. The clear action measures at least 44px high.
- Browser test verifies Cache Storage keys exclude `/api/`, upload/storage URLs, and token fragments; cached HTML excludes the raw access token and two known private report claims. Online HTTP 401 does not use the IndexedDB fallback.

## Self-review and concerns

- Reviewed report route/worker contract, storage keys, response status checks, locale parity, cache deletion, generated asset, and diff. No independent subagent was used, per the explicit task instruction.
- The browser keeps only the most recently saved analysis and the current locale's document shell. Switching to an uncached report locale while offline shows the no-copy explanation. Development HMR chunks do not survive an offline reload reliably, so the browser gate uses a production build. The Next 16 middleware deprecation warning predates this task.

## Fix round 1 — 2026-09-24

- Serialized IndexedDB mutations. Checklist saves now update only the existing record in one readwrite transaction, and clear cannot be followed by a stale whole-store rewrite. The deterministic delayed-read regression ends with neither report nor checklist restored.
- Serialized service-worker shell/asset writes with clear. The delayed shell fetch and delayed static-asset fetch regressions each finish with the respective Cache Storage entry deleted. Subsequent static requests do not recreate an empty cache. `public/sw.js` was regenerated from the TypeScript source.
- Worker readiness and message acknowledgement now have bounded failure paths. When the worker is absent, the online report shows a localized local-only notice and retains the 44px removal action; EN and ET unit tests cover removal. The status does not claim that offline reload works without a shell.
- Observed RED: service-worker static-after-clear test found a recreated shell cache; worker-ready test timed out; EN and ET local-only/removal tests found no notice or action. Observed GREEN: focused offline suite 11/11, full unit suite 244/244, lint exit 0, browser E2E 2/2, diff check clean. Typecheck exited 0 before the webpack build generated route types; the final rerun then failed on the pre-existing route export described below. Desktop and mobile screenshots of online/offline states were visually inspected; the notice and action fit, checklist stays checked, and the existing browser assertion confirms the mobile action height is at least 44px.
- Build note: default `npm run build` fails in this host when Turbopack's CSS worker tries to bind a local port (`Operation not permitted`), including an elevated attempt. `npm run build:webpack` compiles but its Next generated route check rejects the pre-existing exported `createSubmissionHandler` in `src/app/api/analyses/[publicId]/submissions/route.ts` (present at HEAD). A temporary, restored `ignoreBuildErrors` setting allowed the webpack production build to complete for browser E2E; `npm run typecheck` passed separately. The existing middleware/Edge warnings were unchanged.
- Inline self-review covered the transaction completion point, cache write/clear order, absent-worker removal, locale copy, shell-only privacy and generated-worker parity. No subagent was used, as requested.

## Build gate repair — 2026-09-24

This follow-up repairs the Task 13 release gate; it does not change report or submission behavior. A fresh `npm run build` failed because Turbopack's CSS worker could not bind a port on this host (`Operation not permitted`). A fresh `npm run build:webpack` compiled but Next's generated route types rejected the existing non-route `createSubmissionHandler` export in `src/app/api/analyses/[publicId]/submissions/route.ts`. The focused route suite was green (9/9) before the move, and typecheck was red on that generated Next type.

Moved the existing injectable handler unchanged into sibling `handler.ts`; `route.ts` now exports only `POST`, and the route tests import the handler module. The standard `build` script now calls the existing `build:webpack` script, which is a documented Next.js build option and retains TypeScript validation. The changed test import was observed RED while `handler.ts` was absent; after the move, the focused route suite returned GREEN (9/9).

Final gates: `npm run build` exited 0 with Next TypeScript validation enabled; post-build `npm run typecheck` exited 0; full unit suite 244/244; lint exited 0; browser report E2E 2/2; `git diff --check` clean. No `ignoreBuildErrors` override remains. The existing middleware deprecation warning remains. The only behavior proof needed beyond the route tests was the two browser cases; this was an ownership move with no UI change, so the prior desktop/mobile visual review still applies. No subagent was used, as requested.

## Fix round 2 — 2026-09-24

The clear action previously treated any completed `messageWorker("CLEAR_REPORT_SHELL")` call as success, including a `false` timeout or unavailable-worker result. That could claim "Offline copy removed" while shell or assets remained. The IDB clear still runs first, but the UI now requires a `true` worker acknowledgement before showing removal. A false response or thrown error shows a localized "could not confirm full removal" state and keeps a 44px retry action. If the report was already offline, the retry state keeps report controls in offline mode. There is no direct Cache Storage fallback that could race an in-flight worker write.

Observed RED: both EN and ET focused UI cases failed because `false` displayed the removed claim and removed the button. Observed GREEN: both cases passed after the change, including a subsequent `true` acknowledgement on retry. `npm run build` (with Next TypeScript validation), post-build `npm run typecheck`, `npm run lint`, full unit suite 244/244, report browser E2E 2/2, and `git diff --check` all exited 0. The E2E clear path confirms that successful deletion and offline reload still work. Existing middleware/Edge build warnings remain; no subagent was used, as requested.
