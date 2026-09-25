# Task 11 report: approved report interface

## Design plan (recorded before implementation)

### Tokens

- Deep ink `#141d29`: page and report-sheet ground.
- Blue-gray `#202d3d`: restrained raised sections and controls.
- Off-white `#edf1f5`: primary copy and verdict.
- Steel `#abb9c9`: secondary copy, rules, and source metadata.
- Amber `#e8b878`: unresolved inspection rail and caution states only.
- Pale blue `#94bce8`: links, focus, and affirmative action.

### Type

Use the existing Arial/Helvetica UI stack. Personality comes from scale, weight, and alignment rather than a new dependency: a large, tightly tracked sentence-case verdict; compact tabular facts; readable body copy with short lines. Avoid decorative monospace and repeated uppercase eyebrows.

### Layout and wireframe

Left-align all report content. On wide screens, use a broad evidence/report column and a narrower field-actions column; on mobile, preserve the reading order as one continuous inspection sheet.

```text
desktop                              mobile
┌ brand / language ────────────┐    ┌ brand / language ┐
│ verdict + status             │    │ verdict + status │
│ vehicle facts in one strip   │    │ facts, wrapped   │
├───────────────────┬──────────┤    ├──────────────────┤
│ unresolved checks │ seller   │    │ unresolved checks│
│ amber rail        │ request  │    │ seller request   │
│ evidence details  │ checklist│    │ checklist        │
│ source status     │          │    │ source status    │
└───────────────────┴──────────┘    └──────────────────┘
```

### Principles

1. Verdict first: the buyer's go/no-go orientation is the largest element.
2. Inspection vocabulary: rules, rails, plain source states, and field controls—not analytics widgets.
3. Progressive disclosure: evidence remains available without competing with the finding and next action.
4. Amber has one job: mark unresolved checks. It is not general decoration.
5. Buyer actions remain practical: one copyable seller request and a separate touch-friendly viewing checklist.

### Anti-generic self-critique

The initial two-column idea risked becoming a familiar dashboard sidebar, and repeating raised containers could become a SaaS card grid. I revised it into one continuous ruled sheet: sections share alignment and separators, while only action-oriented areas receive a blue-gray surface. Facts are a compact strip rather than equal KPI cards. The only emphatic visual motif is the conditional amber inspection rail. There are no gradients, score rings, glass effects, car illustration, decorative numbered sections, or repeated label/headline/card recipes.

## Implementation summary

- Added the private bilingual report route at `/{locale}/a/{publicId}` with fragment-token bootstrap, token-scoped server loading, language navigation, and an access-pending state.
- Built the approved dark inspection-sheet composition: verdict-first hierarchy, compact vehicle facts, conditional amber rails for open findings, accessible evidence disclosures, plain source status, one seller-request copy action, and a separate mobile-first viewing checklist.
- Added progressive server refresh every three seconds for non-terminal reports. Refresh stops on `complete`, `failed`, component unmount, or after the tab remains hidden for more than 30 seconds. One polite live region announces status changes.
- Added complete ET/EN interface translations while retaining evidence excerpts and report-authored content in their source language.
- Added report fixtures and unit coverage for hierarchy, provenance labels, evidence disclosure, localized copy, checklist state/touch target, refresh cadence, terminal states, hidden-tab cutoff, and unmount cleanup.
- Added a strict Playwright journey that seeds a real report through the existing repository, submits an Auto24 URL, performs the real fragment access exchange, exercises evidence/language/checklist interactions, and checks 390 x 844 horizontal overflow.
- Preserved the Task 4 retry contract: rejected access exchanges are caught and the URL fragment remains available for reload retry.

## TDD RED/GREEN evidence

- Inherited RED prescribed by the brief: `ReportView` and its fixture/tests were specified before the components existed. The prior agent did not record the original command output, so this historical RED cannot be independently reproduced from the surviving report.
- Audited partial RED: `npm run test -- tests/unit/report tests/unit/submission/access-bootstrap.test.tsx` failed 4 report-view tests because the partial test harness lacked an app-router boundary; it also emitted timezone fallback warnings.
- After repairing the harness, a behavior RED remained: the hierarchy test could not find a visible `Seller claim / Unverified` label because provenance existed only inside the collapsed panel.
- GREEN repair: provenance/verification is now visible in the disclosure trigger while the source excerpt remains collapsed. The focused suite then passed 14/14.
- Additional GREEN coverage added for ET interface/copy, failed-state polling, hidden-tab cutoff, interval cleanup, and the deferred rejected-exchange retry behavior.
- The access-bootstrap test was inherited with partial code. Its original failing transcript was not preserved; the final focused run proves the retained implementation passes both success and rejected-exchange paths.

## Verification

- `npm run test -- tests/unit/report` — PASS, 3 files and 12 tests.
- `npm run test -- tests/unit/submission/access-bootstrap.test.tsx` — PASS, 1 file and 2 tests.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `npm run test:e2e -- tests/e2e/analysis.spec.ts` — BLOCKED BY ENVIRONMENT. With elevated permission, the Next.js server and Chromium started and the single test began, then failed before seeding with: `Report E2E requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for seeded data.` The test remains strict; it was not skipped or replaced with a mocked report page.
- Initial sandboxed Playwright attempt could not bind port 3000 (`listen EPERM`). Re-running with the required permission resolved the browser/server limitation and exposed the missing backend credentials above.

## Files changed

- `src/app/[locale]/a/[publicId]/page.tsx`
- `src/features/report/access-bootstrap.tsx`
- `src/features/report/evidence-disclosure.tsx`
- `src/features/report/report-refresh.tsx`
- `src/features/report/report-view.tsx`
- `src/features/report/seller-message.tsx`
- `src/features/report/viewing-checklist.tsx`
- `src/app/globals.css`
- `messages/en.json`
- `messages/et.json`
- `tests/fixtures/sample-report.ts`
- `tests/unit/report/report-view.test.tsx`
- `tests/unit/report/report-refresh.test.tsx`
- `tests/unit/submission/access-bootstrap.test.tsx`
- `tests/e2e/analysis.spec.ts`

## Self-review findings and concerns

- Reviewed every surviving Task 11 change against the brief and retained the approved inspection-sheet plan. No car illustration, gradient, glass effect, score ring, equal KPI cards, excessive rounding, mixed icon families, or unrequested dependency was introduced.
- Confirmed amber is limited to unresolved findings/caution semantics; report structure uses shared rules rather than a grid of equal cards; evidence excerpts remain behind accessible disclosures; action controls use existing shadcn primitives and checklist labels provide a 44 px minimum target.
- Confirmed the progressive refresh interval is cleared for terminal status, prolonged hidden state, and unmount, and that only one polite live region is rendered.
- Confirmed the deferred Task 4 rejection is caught without clearing the fragment or refreshing.
- `git diff --check` passed before final verification. Unrelated `tests/unit/.DS_Store`, `AGENTS.md`, and `CLAUDE.md` were not modified, deleted, or staged.
- Concern: the required Playwright/manual visual acceptance could not complete without local Supabase URL and service-role credentials. Browser code is typechecked/linted and the runner reaches the strict seed precondition, but the real UI journey and screenshot-level visual review remain unverified in this environment.
- Per the direct instruction for this replacement task, no subagent was dispatched; self-review was completed inline.
- Commit created: `10f4df1 feat(ui): add verdict-first inspection report`.
- Concern: the repository requires a PR for feature completion, but pushing `codex/used-car-prototype` to `origin` was denied because this session did not have explicit authorization to export repository code to that remote. No push or PR was performed.

## Fix round 1: Playwright submit/navigation boundary

### Root cause and investigation

- Reproduced the browser failure against the local Supabase stack before changing production code.
- Instrumented the submit boundary. No `POST /api/analyses` response was observed. After the click, the page URL was `http://127.0.0.1:3000/et?listingUrl=https%3A%2F%2Fwww.auto24.ee%2Fsoidukid%2F123456`, the button had returned to `Alusta analüüsi`, and the inspection message remained at its server-rendered waiting text. This proved the browser performed a native GET because the React submit/change handlers were not attached.
- Browser/server diagnostics repeatedly reported that Next.js blocked dev resources from origin `127.0.0.1`; HMR WebSocket handshakes failed. The existing submission unit test passed because it replaces Next's router with a mock and runs after React Testing Library has mounted the component, so it did not exercise dev-server hydration.
- Hypothesis 1: Playwright clicked only during a short hydration window. Minimal test: delay interaction by one second. Result: still RED with the same native GET and no POST, disproving a transient timing race.
- A temporary production hydration guard left the input disabled for the full 30-second test timeout, confirming hydration never occurred; that attempted fix was fully reverted.
- Hypothesis 2: the Playwright `127.0.0.1` origin conflicts with Next dev's accepted `localhost` origin and prevents hydration. Minimal test: change both Playwright `baseURL` and `webServer.url` to `http://localhost:3000`. Result: confirmed. Next logged `[HMR] connected`; the form sent the expected POST, received HTTP 201 with the seeded private report URL, navigated to `http://localhost:3000/et/a/{publicId}#access={token}`, and completed the entire report journey.

### Fix

- Kept the application and E2E journey unchanged.
- Changed only `playwright.config.ts` so the browser and web-server readiness probe consistently use `http://localhost:3000`.
- Removed all temporary diagnostics and experimental production code.
- Restored generated `next-env.d.ts` imports from `.next/dev/types` to the tracked `.next/types` form; it is excluded from the fix.

### RED/GREEN and verification

- RED: `npm run test:e2e -- tests/e2e/analysis.spec.ts` with local Supabase credentials under `127.0.0.1` — FAIL; no POST response, native GET to the home route, verdict absent.
- GREEN hypothesis run under `localhost` — PASS, 1/1 Playwright test; captured POST body matched `{ locale: "et", listingUrl: "https://www.auto24.ee/soidukid/123456" }`, response status was 201, and the browser reached the private fragment URL.
- Clean final `npm run test:e2e -- tests/e2e/analysis.spec.ts` with local Supabase credentials — PASS, 1/1 in 6.8 seconds.
- `npm run test -- tests/unit/report tests/unit/submission` — PASS, 9 files and 31 tests.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `git diff --check` — PASS.

### Files changed and self-review

- `playwright.config.ts`
- The fix is test-harness-only and preserves the real seeded POST, Next router navigation, fragment exchange, report load, evidence disclosure, ET-to-EN switch, checklist interaction, and 390 x 844 overflow assertion.
- Unrelated untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` remain untouched and will not be staged.

## Review fix round 1: language scoping, clipboard recovery, and fact identity

### Review findings and rulings

- Confirmed the mixed-language accessibility issue. The article and translated UI chrome remain scoped to the active route locale, while persisted finding titles, explanations, next actions, seller-message content, and checklist task content now use `report.locale`.
- Confirmed that evidence has no independent source-language metadata in the domain type, persistence schema, listing snapshot, or provider contracts. Per the ruling, no field or migration was invented. Evidence claim/applicability text uses `report.locale`, the only persisted language signal available to Task 11.
- Exact original-source language remains unavailable. Synthesizing it from text, source class, route locale, or listing host would weaken provenance by presenting an inference as captured metadata. A future schema/provider change would be required to represent source language exactly.
- Confirmed clipboard failures were unhandled and copy success could become stale after progressive actions changed. Clipboard absence and rejected writes now produce localized visible retry guidance without adding another polite live region. Copy outcome is keyed to the composed message, so both copied and failed states reset when the message changes.
- Confirmed equal facts from distinct sources produced duplicate React keys. The key now includes the already-persisted `sourceId`; no domain expansion was needed.

### TDD RED/GREEN evidence

- Added focused tests before implementation for active EN UI with `report.locale = "et"`, including finding, seller-message, checklist, evidence claim, and evidence applicability language scopes.
- Added focused tests for missing Clipboard API, rejected `writeText`, copied-state reset, failed-state reset, and duplicate fact values from distinct sources.
- RED: `npm run test -- tests/unit/report/report-view.test.tsx --reporter=dot` — 7 failed, 5 passed, with three unhandled clipboard rejections. Failures showed absent `lang="et"`, absent retry feedback, stale copy states, and React's duplicate-key warning.
- GREEN: the same command — PASS, 1 file and 12 tests with no unhandled errors.

### Implementation and files changed

- `src/features/report/report-view.tsx`: scoped finding fields, threaded `report.locale`, and included `sourceId` in fact keys.
- `src/features/report/evidence-disclosure.tsx`: scoped claim/applicability to the report locale without changing evidence contracts.
- `src/features/report/seller-message.tsx`: added report-locale scoping, safe clipboard fallback/rejection handling, visible retry feedback, and message-keyed outcome reset.
- `src/features/report/viewing-checklist.tsx`: scoped task title/instructions to the report locale.
- `messages/en.json`, `messages/et.json`: added localized clipboard retry guidance.
- `tests/unit/report/report-view.test.tsx`: added mixed-locale, clipboard, reset, and duplicate-key regressions.

### Verification

- `npm run test:e2e -- tests/e2e/analysis.spec.ts` with complete local Supabase environment — PASS, 1/1 in 6.4 seconds.
- `npm run test -- tests/unit/report tests/unit/submission` — PASS, 9 files and 38 tests.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `git diff --check` — PASS.

### Self-review and concerns

- No second polite live region was introduced; clipboard failure text is visible inline and the existing report-stage live region remains the only polite announcer.
- The active route locale still scopes translated report chrome; only report-authored persisted strings override it.
- No domain, schema, migration, snapshot, provider, or dependency changes were made.
- Generated `next-env.d.ts` was restored after browser verification. Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` remain untouched.
- Remaining provenance limitation: exact evidence source language cannot be represented until upstream contracts persist it.

## Review fix round 2: seller preview language boundaries

### Finding and implementation

- Confirmed the rereview's remaining Important finding: the single seller-request textarea combined active-route translations with persisted report-authored instructions, then labeled the whole control with `report.locale`.
- Kept `Questions for the seller` / `Requested photos` as ordinary translated headings under the active route locale.
- Split report-authored instructions into separate read-only shadcn `Textarea` controls, rendered only when their corresponding action group exists and each explicitly tagged with `lang={contentLocale}`.
- Preserved one copy button and the exact combined clipboard structure: active-locale heading, question instructions, blank line, active-locale heading, requested-photo/document instructions.
- Preserved missing Clipboard API and rejected-write recovery plus message-keyed copied/failed state reset. Updated localized failure guidance to direct manual selection to the text above now that there are two selectable controls.
- No domain, schema, persistence, evidence, or surrounding report-layout contracts changed.

### TDD RED/GREEN evidence

- Added the focused mixed-locale regression before production edits. It renders active EN UI with `report.locale = "et"`, asserts both active-locale seller headings are outside ET language containers, and asserts both report-authored textareas use `lang="et"` and contain only instructions.
- Updated clipboard recovery assertions before production edits for the two-control manual-copy guidance.
- RED: `npm run test -- tests/unit/report/report-view.test.tsx --reporter=dot` — FAIL, 4 failed and 9 passed. The split headings/controls were absent and all three updated recovery-copy assertions still saw the old translation.
- First implementation run: 1 failed and 12 passed because the new test had an incorrect expected fixture phrase (`dashboard photos`); inspecting the rendered fixture showed the actual persisted instruction was `the VIN page`. Corrected the test data expectation without changing production behavior.
- GREEN: the same focused command — PASS, 1 file and 13 tests.

### Verification

- `npm run test -- tests/unit/report tests/unit/submission` — PASS, 9 files and 39 tests.
- Local Supabase environment plus `npm run test:e2e -- tests/e2e/analysis.spec.ts` — PASS, 1/1 Chromium test in 6.1 seconds.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `git diff --check` — PASS, exit 0.
- Browser verification regenerated `.next/dev/types` imports in `next-env.d.ts`; the tracked `.next/types` form was restored and `next-env.d.ts` is absent from the final diff.

### Files changed and self-review

- `src/features/report/seller-message.tsx`
- `tests/unit/report/report-view.test.tsx`
- `messages/en.json`
- `messages/et.json`
- Self-review confirmed there is exactly one copy button; copied text still includes both localized headings and both instruction groups; each instruction group is independently selectable; absent/rejected clipboard behavior and stale-state resets remain covered; and report-authored content alone carries the report locale.
- Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` remain untouched and are excluded from staging.
- Concerns: none for this fix round.

## Review fix round 3: exact manual clipboard fallback

### Finding and implementation

- Confirmed the rereview's remaining Important finding: after the normal preview was split by language scope, clipboard failure guidance no longer exposed one selectable representation of the exact combined request attempted through `writeText`.
- Kept the normal route-localized headings and report-locale instruction textareas unchanged.
- Added one failure-only read-only shadcn `Textarea` whose value is the same `message` string passed to `navigator.clipboard.writeText`, including active-locale headings and both report-authored instruction groups.
- Marked the mixed-language fallback with `lang=""` so it does not falsely claim either the route locale or report locale.
- Added localized EN/ET accessible labels and guidance directing the buyer to select the complete fallback field manually.
- Preserved exactly one copy button. The existing message-keyed copy result controls the fallback, so both failure guidance and fallback disappear whenever progressive report actions change the composed message.

### TDD RED/GREEN evidence

- Expanded tests before production edits. The focused rejection regression uses a hand-derived literal for the attempted clipboard payload, verifies `writeText` received it, and requires a visible fallback textbox with the exact same value and `lang=""`; after rerendering changed actions, it requires the fallback to disappear. Existing mixed-locale split-preview assertions remain unchanged.
- RED: `npm run test -- tests/unit/report/report-view.test.tsx --reporter=dot` — FAIL, 3 failed and 10 passed. The new combined fallback textbox was absent, and the missing/rejected clipboard tests still rendered the old recovery guidance.
- GREEN: the same focused command — PASS, 1 file and 13 tests.

### Verification

- `npm run test -- tests/unit/report tests/unit/submission` — PASS, 9 files and 39 tests.
- Local Supabase environment plus `npm run test:e2e -- tests/e2e/analysis.spec.ts` — PASS, 1/1 Chromium test in 6.1 seconds.
- `npm run typecheck` — PASS, exit 0.
- `npm run lint` — PASS, exit 0.
- `git diff --check` — PASS, exit 0.
- Browser verification regenerated `.next/dev/types` imports in `next-env.d.ts`; the tracked `.next/types` form was restored and `next-env.d.ts` is absent from the final diff.

### Files changed and self-review

- `src/features/report/seller-message.tsx`
- `tests/unit/report/report-view.test.tsx`
- `messages/en.json`
- `messages/et.json`
- Self-review confirmed the normal split preview and route/report language scopes are unchanged; the fallback appears for both missing Clipboard API and rejected writes through their shared failed state; it directly reuses the attempted payload rather than reconstructing it; no second copy trigger or live region was added; and stale failure UI remains keyed to the exact composed message.
- Untracked `AGENTS.md`, `CLAUDE.md`, and `tests/unit/.DS_Store` remain untouched and are excluded from staging.
- Concerns: none for this fix round.
