# Task 14 release gate report

Branch: `codex/used-car-prototype`. Base: `2398ea9b641553a57817953aa0224506daaa9884`. Existing PR: [#1](https://github.com/M4stas/kontroll/pull/1). Final tested commit: `50419b5`. No subagents were spawned; the controller will arrange the independent whole-branch review. The PR body was deliberately left for that review outcome.

## Local setup and scope

The README now gives the fresh-setup sequence (`npm install`, `npx supabase start`, `npx supabase db reset`, `cp .env.example .env.local`, `npm run dev`, `npm run worker`) with the environment-fill step before app startup. The existing local Supabase database was **not reset**. Tests used the already-running loopback Supabase instance. `.env.local` is ignored by Git and contains only local test configuration. The runbook covers the worker, `AUTO24_FETCH_ENABLED`, fallback submissions, optional Luna, Transport Administration `not_checked`, privacy, offline copies, excluded price/paid features, and limits.

## Findings fixed during the release gate

1. Playwright did not load `.env.local` into its test process: the first full E2E attempt was 1 passed / 2 failed before the report tests opened a browser. The config now loads Next environment files. Rerun: all browser tests passed.
2. `npm run worker` exited 0 without starting a worker because its target only exported functions. A red worker-entry test reproduced the no-op; `scripts/worker.ts` now configures the repositories, Auto24 adapter, optional insight environment, stage handlers, and lease loop. The test passed after the fix, and the process handled live submissions.
3. Final assembly replaced the run's findings/actions with only optional enrichment records, erasing the deterministic baseline. A focused integration test failed with two missing findings. Final assembly now persists the complete filtered report. Focused test and live browser rerun passed.
4. Mobile header links measured 15–20 px high/width. A focused browser test failed. Home and report navigation now expose at least 44 × 44 px links; focused and full browser tests passed.
5. A supplement that inherited research lost the Transport Administration status because the loader selected a run with no official-source snapshot. A focused integration test failed; loader now selects the newest terminal research run that has an official snapshot. The test and final live supplement rerun passed.

## Complete automated gate

Final source-tree gate after fixes (all commands exited 0; no full-suite test skips):

| Command | Result |
| --- | --- |
| `npm run test` | exit 0; 36 files, 245 tests passed |
| `npm run test:integration` | exit 0; 6 files, 54 tests passed |
| `npm run test:e2e` | exit 0; 4 Chromium tests passed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0; Next 16.3.5 webpack build compiled and generated 5 static pages |
| `git diff --check` | exit 0 |

The build emitted Next's existing `middleware`-convention deprecation notice. Local Supabase status reported some optional services stopped while API/database/storage remained usable. The final gate was repeated after all source and test fixes. README ordering was clarified afterward; the final diff check was repeated before commit.

## Manual desktop, current local app and worker

Playwright drove a real Chromium browser and the local production app at `http://localhost:3000`. `https://www.auto24.ee/soidukid/123456` was a **fixture-shaped URL**; `AUTO24_FETCH_ENABLED=false`, so no live Auto24 page was fetched. The app recognized an Auto24 URL, created a private report, and took the documented fallback path (`capture_fetch_disabled`). Polling observed `queued`, `running`, and `complete` states; the local worker ran every durable stage. The fast local run did not leave a separately visible `partial` frame in browser polling; the integration test verifies the partial report is persisted before optional research/enrichment.

The final live initial report had two deterministic open findings, `proceed_cautiously`/low confidence, `research_unavailable` and `enrich_unavailable` warnings, and Transport Administration `not_checked`. A separate browser context with only the bare report URL saw the private-access heading; its report API returned 401. ET and EN navigation rendered the expected translated verdict. Evidence expansion exposed the unverified missing-identity claim. Copying the seller request produced the confirmation state and clipboard text containing the VIN question.

The same live report accepted seller text and a PNG upload. Its status cycled through queued/running and returned to complete, with three open findings; the uploaded material remained unverified, and Transport Administration remained `not_checked`. Its verdict value stayed `proceed_cautiously`, which is consistent with the deterministic policy. The separate seeded fixture browser journey verified a **value change on the same report** from `worth_viewing` to `proceed_cautiously` after a PNG supplement and simulated image insight. That fixture observation is not evidence of a live Luna response.

Screenshots (relative to this worktree):

- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/desktop-submission.png` — recognized URL before submission.
- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/desktop-progress.png` — early report during the first live run.
- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/desktop-private-denial.png` — second-session access-check placeholder; its filename does not describe a visible denial.
- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/desktop-live-evidence.png` — expanded evidence on the repaired report.
- `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/desktop-final-supplement.png` — final live supplemented report with official-source status.
- `test-results/analysis-opens-a-seeded-re-a5903-s-the-buyer-inspection-flow-chromium/report-updated-mobile.png` — seeded fixture verdict change and image observation.

## Manual mobile, 390 × 844

The final live supplemented report had `documentElement.clientWidth=390`, `scrollWidth=390`, and no visible link, button, text field, or select below 44 × 44 px. The mobile home and report navigation assertions passed. The seeded fixture journey expanded an evidence disclosure, used the seller copy control, checked the viewing checklist, uploaded a PNG, and observed the same-report verdict change. The offline journey saved the report, reloaded with the browser offline, retained the checked checklist item, reconnected, removed the offline copy, and confirmed an offline reload then showed no local copy. All four browser E2E cases passed on the final build.

Mobile screenshots: `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/task-14-screenshots/mobile-final-supplement.png`, `test-results/analysis-opens-a-seeded-re-a5903-s-the-buyer-inspection-flow-chromium/report-evidence-mobile.png`, `test-results/analysis-retains-the-lates-87cf6-then-removes-the-local-copy-chromium/report-mobile.png`, and `test-results/analysis-retains-the-lates-87cf6-then-removes-the-local-copy-chromium/offline-mobile.png`.

## Caveats and self-review

Direct enabled Auto24 capture against a real current listing was not verified: this run used the disabled flag and fallback on a fixture-shaped URL. CAPTCHA and access-control bypass are outside scope. No live Luna credentials were configured; deterministic completion and warning behavior were exercised. The official Transport Administration check remained unavailable and correctly said `not_checked`. The price estimate and paid report remain excluded.

Self-review inspected the changed worker startup, environment loading, complete-assembly persistence, source lineage selection, header targets, and the regression assertions. No further task-local finding remained after the final gate and live rerun. The independent whole-branch reviewer has not yet reported; the controller owns that step and the PR-body reviewer outcome. The entire SDD directory, including `agents.md`, `progress.md`, briefs, reports, and screenshots, is preserved on disk. Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` were not staged or changed.

Final commit: `50419b5ae6894b61b2ac1d1b627c8710678d6a6c` (`docs: add prototype runbook and release fixes`), pushed to `origin/codex/used-car-prototype`. PR #1 remained OPEN on that branch; `statusCheckRollup` was empty. Final `git status --short` showed only the preserved untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store`.

## Targeted desktop evidence follow-up (2026-09-25, HEAD `50419b5`)

At 1280 × 800 in Playwright-controlled desktop Chromium, two focused local browser journeys passed (`2 passed`, 31.1 s). Screenshots were visually inspected. Temporary additions to `tests/e2e/analysis.spec.ts` used for capture were removed afterward; that file has no remaining diff. The local test reports and uploads were cleaned up after capture, so the URLs below identify the same report within each journey but are no longer live links. No production code, PR body, or SDD directory contents were removed.

- **Partial → complete:** Submitted the fixture-shaped `https://www.auto24.ee/soidukid/123456` through the actual app at `http://localhost:3000/en/a/222db4d5-1788-4d98-8f6c-81932d7b0a16` (private fragment omitted). With no continuous worker competing, a local service-role worker used the production `createStageHandlers`/`processJob` path and an `Auto24ListingAdapter` with `fetchEnabled: false`. It processed capture, normalization, baseline, and first assembly, then paused before optional research/enrichment. The database status was `partial`, and the browser visibly showed “Initial report ready; further checks are running” with two findings in `task-14-screenshots/desktop-partial-before-optional.png`. The same worker then processed research, enrichment, and final assembly; database status became `complete`, the browser stayed on the exact same private URL, and `task-14-screenshots/desktop-partial-after-optional.png` shows “Analysis complete.” This proves a browser-visible partial state with controlled optional-stage timing; it does not prove live Auto24 fetching or Luna output.
- **Same-public-URL verdict change:** The existing seeded E2E report at `http://localhost:3000/en/a/4f546242-9052-4bd0-ae20-cab6a3d0a743` (private fragment omitted) showed `worth_viewing`/“Worth a viewing” in `task-14-screenshots/desktop-seeded-verdict-before.png`. In that same browser URL, the fixture uploaded a generated PNG and ran its simulated image-insight provider through the real supplement job handlers. `task-14-screenshots/desktop-seeded-verdict-after.png` shows `proceed_cautiously`/“Proceed cautiously,” the new image observation, and the PNG as processed. This is seeded fixture evidence, not a live Luna response.
- **No-secret access check; visible denial gap remains:** A fresh browser context with no access fragment or cookie opened the bare partial-journey URL above. A separate report API request in that context returned HTTP 401. After another second, `task-14-screenshots/desktop-private-denial-settled.png` still displayed “Opening the inspection report”; despite its filename, it is **not** evidence of a visible denial. Code inspection explains the transition: `AccessBootstrap` returns when there is no fragment token; `OfflineReport` maps a non-OK report response to `unavailable` and renders the page's `accessFallback`, whose text still says “Opening the inspection report.” The earlier `desktop-private-denial.png` shows the same placeholder. API access was denied, but the requested desktop denial-state screenshot was not obtained. This appears to be a UI state/copy defect for the final fix agent to assess; no product code was changed in this follow-up.
