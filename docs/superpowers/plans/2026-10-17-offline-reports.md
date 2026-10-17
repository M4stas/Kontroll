# Offline Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Roadmap checkpoints 8 and 9. The user approved the spec on 2026-10-17. Start from `main` after the docs PR that adds this plan merges.

The plan has two parts with a stop between them. **Part A (checkpoint 8)** ends with its own PR. Stop there. **Part B (checkpoint 9)** starts only after the user has checked Part A in the app and approved Part B.

**Goal:** A buyer saves a report on their device, finds it on the front page, and opens it with no connection.

**Architecture:** Saved reports are `AnalysisReport` JSON in IndexedDB, one record per `publicId`. Part A adds the store, a 30-day access cookie, a save strip on the report page and a saved list on the front page. Part B adds a hand-written TypeScript service worker at scope `/`. It serves the cached front page, a cached data-free report shell per saved report, and the build's `/_next/static/` files when the network fails.

**Tech Stack:** Next.js 16 (webpack build), React 19, TypeScript, Zod, next-intl, Vitest with jsdom. New dev dependencies: `fake-indexeddb` (Part A), `esbuild` and `@playwright/test` (Part B).

**Spec:** [Offline reports design](../specs/2026-10-17-offline-reports-design.md). Read it before each part. The front page list copies prototype variant A on branch `prototype/saved-reports` (`src/features/saved-reports-prototype/saved-reports-prototype.tsx`). Read it for layout and CSS only, and do not merge that branch. The old offline code on `codex/used-car-prototype` (`public/sw.js`, `src/features/offline/report-cache.ts`) is reference only. Follow the [agent policy](../../agent-policy.md) for every dispatch.

## Global Constraints

- Saved copy lifetime and access cookie lifetime: 30 days. Save and Update restart both.
- `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES` replaces the 30-day record lifetime only when `NODE_ENV !== "production"`. The cookie always keeps 30 days.
- A 401 or 403 never deletes a saved copy. Only expiry, an invalid record, and Remove delete one, and each deletes only its own record and shells.
- IndexedDB database `kontroll-offline`, version 1, store `reports`, keyPath `publicId`. Record `schemaVersion: 1`.
- No report data in any HTML the worker caches. The worker never caches a response to a normal report page load.
- The worker calls `respondWith` only for page loads of `/`, `/et`, `/en`, `/{et|en}/r/{uuid}`, and for `GET /_next/static/*`. All other requests, including `/api/*`, pass through.
- Every user-facing string exists in Estonian and English. Report strings live under `Report.offline` in `messages/*.json`. Front page strings live in `src/features/listing/messages.ts`.
- UI follows `DESIGN.md`: existing tokens, `primary-button`, `secondary-button`, pill controls and `--r-card`. No new colors.
- Read `node_modules/next/dist/docs/` for route handlers, `headers()` and `next.config` headers before touching `src/app/` or `next.config`.
- Gates for every task: `npm test && npm run lint && npm run typecheck`. Add `npm run build` at the end of each part.

## Review Focus

- **IndexedDB unavailable** (private browsing, blocked storage): the save strip shows "Saving isn't available in this browser", and the front page shows no list. Nothing throws. Test in Tasks 2 and 3.
- **The cookie is gone when the buyer presses Save** (browser restarted before this change shipped): the strip says to open the private link again, and nothing is deleted. Test in Task 3.
- **Saving while a review is still running:** the strip appears only once the report cards are shown, not on the review screen. Test in Task 3.
- **Two open tabs:** saving or removing in one tab updates the front page list in the other. Test in Task 4.
- **A report saved in one language and opened offline in the other:** both `/et/r/{id}` and `/en/r/{id}` shells are cached, so either address works offline. Test in Task 6.

---

# Part A: Checkpoint 8, save a report on this device

### Task 1: 30-day access cookie and renewal route

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/server/http/same-origin.ts`
- Modify: `src/app/api/analyses/[publicId]/access/route.ts`, `src/app/api/analyses/[publicId]/retry/handler.ts:19-21`
- Test: `tests/unit/access/access-route.test.ts`, existing `tests/unit/report/retry-route.test.ts` stays green

**Interfaces:**
- Produces: `isSameOriginRequest(request: Request): boolean`, the check now inline in the retry handler at lines 19 to 21, moved without changes in behavior. `ACCESS_COOKIE_MAX_AGE_SECONDS = 2_592_000` exported from `src/server/access/analysis-access.ts`. `PUT /api/analyses/[publicId]/access`: 200 `{ ok: true }` and a renewed cookie, or 401 `{ error: "Access denied" }`, or 403 for a cross-origin request. All responses `Cache-Control: private, no-store`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/access/access-route.test.ts`:
  - `POST sets the access cookie with Max-Age=2592000`
  - `PUT with a valid cookie re-sets the same cookie value with Max-Age=2592000`
  - `PUT without a cookie returns 401 and sets no cookie`
  - `PUT with a cookie for another publicId returns 401`
  - `PUT from another origin returns 403`
- [ ] **Step 2: Run** `npx vitest run tests/unit/access`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Extract `isSameOriginRequest`, use it in the retry handler and in `PUT`. `PUT` verifies with `verifyAnalysisAccess({ publicId, cookie })` and re-sets the existing cookie value with the same options as `POST` plus `maxAge`.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(access): keep the report access cookie for 30 days`

### Task 2: Saved reports store

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/features/offline/saved-reports-db.ts`, `src/features/offline/expiry.ts`, `src/features/offline/save-report.ts`
- Modify: `package.json` (dev dependency `fake-indexeddb`), `vitest.setup.ts` (import `fake-indexeddb/auto`)
- Test: `tests/unit/offline/saved-reports-db.test.ts`, `tests/unit/offline/save-report.test.ts`

**Interfaces:**
- Produces, in `saved-reports-db.ts`:
  - `type SavedReportRecord = { schemaVersion: 1; publicId: string; locale: Locale; report: AnalysisReport; savedAt: string; expiresAt: string; checklist: Record<string, boolean> }`
  - `getSavedReport(publicId: string): Promise<SavedReportRecord | null>`. It deletes and returns null for a record that is expired, fails `AnalysisReportSchema`, or has another `schemaVersion`.
  - `listSavedReports(): Promise<SavedReportRecord[]>`, newest `savedAt` first, with the same cleanup.
  - `putSavedReport(record: SavedReportRecord): Promise<void>` and `deleteSavedReport(publicId: string): Promise<void>`, both through one ordered write queue.
  - `subscribeSavedReports(listener: () => void): () => void`. It fires on local writes and on `BroadcastChannel("kontroll-offline")` messages from other tabs.
  - `savedReportsAvailable(): boolean`. False when `indexedDB` is missing or opening the database fails.
- Produces, in `expiry.ts`: `offlineLifetimeMs(): number`.
- Produces, in `save-report.ts`:
  - `type SaveResult = { status: "saved"; record: SavedReportRecord } | { status: "cancelled" } | { status: "access-denied" } | { status: "storage-full" } | { status: "unavailable" } | { status: "failed" }`
  - `saveReport(publicId: string, locale: Locale): Promise<SaveResult>`. It calls `PUT /api/analyses/{publicId}/access`, then `GET /api/analyses/{publicId}/report`, then writes. It calls `navigator.storage.persist?.()` once per page load.
  - `removeSavedReport(publicId: string): Promise<void>`. It cancels an in-flight `saveReport` for the same `publicId`, which then returns `cancelled` and writes nothing.

- [ ] **Step 1: Write the failing tests.**
  - `saved-reports-db.test.ts`: `put then get returns the record`, `get deletes and returns null for an expired record`, `get deletes a record that fails AnalysisReportSchema`, `get deletes a record with schemaVersion 2`, `delete removes only that publicId`, `list orders by savedAt newest first`, `subscribe fires for a write`, `savedReportsAvailable is false when indexedDB is undefined`.
  - `save-report.test.ts` (mock `fetch`): `saves with expiresAt 30 days after savedAt`, `uses NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES outside production`, `returns access-denied on a 401 from PUT and keeps an existing record`, `returns storage-full on QuotaExceededError`, `remove during the report fetch returns cancelled and leaves no record`, `saving A never changes B`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/offline`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules with plain `indexedDB` (no wrapper library). Model the write queue on the prototype's `report-cache.ts`.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(offline): store saved reports in IndexedDB`

### Task 3: Save strip on the report page

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/features/offline/save-strip.tsx`, `src/features/offline/ios-storage-warning.ts`, `src/app/[locale]/styles/offline.css`
- Modify: `src/features/report/report-view.tsx`, `src/app/[locale]/globals.css` (import `offline.css`), `messages/en.json`, `messages/et.json`
- Test: `tests/unit/offline/save-strip.test.tsx`, `tests/unit/report/report-view.test.tsx`

**Interfaces:**
- Consumes: Task 2's `saveReport`, `removeSavedReport`, `getSavedReport`, `subscribeSavedReports`, `savedReportsAvailable`.
- Produces: `SaveStrip({ report, locale }: { report: AnalysisReport; locale: Locale })`. `needsIosStorageWarning(): boolean`, true for an iOS user agent when `navigator.standalone !== true`.

- [ ] **Step 1: Write the failing tests** in `save-strip.test.tsx`:
  - `shows Save on this device when nothing is saved`
  - `after saving shows the saved date and kept-until date in the page locale`
  - `shows a newer-version notice when report.updatedAt is later than the saved copy`
  - `Update replaces the copy and clears the notice`
  - `Remove returns to the unsaved state`
  - `access-denied says to open the private link again`
  - `storage-full shows the storage message`
  - `unavailable shows Saving isn't available in this browser`
  - `shows the iPhone 7-day warning only when needsIosStorageWarning is true`
  - `renders in Estonian`

  In `report-view.test.tsx`: `save strip is shown with the cards`, `save strip is hidden on the review screen`, `save strip is hidden when offline`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/offline tests/unit/report/report-view.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Render `SaveStrip` in `ReportView` inside the `showReport` branch, before `ReportCompletion`, when `offline` is false. Strings go under `Report.offline`. Restore wording from the prototype branch's `Report.offline` strings where it fits.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(offline): save a report from the report page`

### Task 4: Saved list on the front page

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/features/offline/saved-list.tsx`
- Modify: `src/app/[locale]/page.tsx`, `src/features/listing/messages.ts`, `src/app/[locale]/styles/offline.css`
- Test: `tests/unit/offline/saved-list.test.tsx`

**Interfaces:**
- Consumes: Task 2's `listSavedReports`, `removeSavedReport`, `subscribeSavedReports`. Task 3's `needsIosStorageWarning`. `vehicleTitle` from `src/features/report/vehicle-title.ts`.
- Produces: `SavedList({ locale }: { locale: Locale })`, a client component rendered after `SubmissionForm` inside `.home-hero`.

- [ ] **Step 1: Write the failing tests:**
  - `renders nothing when no report is saved`
  - `lists reports newest first with title, saved date and kept-until date`
  - `Open links to /{locale}/r/{publicId}`
  - `Remove deletes only that report`
  - `updates when another tab saves a report`. Post on a second `BroadcastChannel("kontroll-offline")`.
  - `renders nothing when savedReportsAvailable is false`
  - `renders in Estonian`
- [ ] **Step 2: Run** `npx vitest run tests/unit/offline/saved-list.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with the layout and CSS of prototype variant A: heading "Saved on this device", card rows, Open as `secondary-button`, Remove as a quiet text button, and the phone rule from the prototype that keeps Remove on screen. Render after mount only, so the server HTML is the same for every visitor.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(offline): list saved reports on the front page`

### Task 5: Part A acceptance and PR

Role: coordinator, with manual frontend E2E and independent code review from the agent policy.

- [ ] **Step 1: Run** `npm test && npm run lint && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 2: Manual E2E** in the internal browser, following the spec's checkpoint 8 "How to check" steps 1 to 8, at 1440px and 390px, in light and dark. Use a report the user provides. Save screenshots to `docs/superpowers/checkpoints/offline-8/`.
- [ ] **Step 3: Independent review**, plus the final review for privacy from the agent policy (cookie lifetime and data kept on the device). Fix the findings and repeat the affected checks.
- [ ] **Step 4: Document.** Replace the "offline saving is not implemented" lines in `README.md` and `docs/local-development.md`. Add `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES` to `docs/local-development.md`. Record the evidence in `docs/superpowers/checkpoints/2026-10-17-offline-8.md`. In the roadmap, set checkpoint 8 to "PR open; user acceptance pending".
- [ ] **Step 5: Open the PR** against `main` with the `/pr` skill. **Stop.** Part B needs the user's approval.

---

# Part B: Checkpoint 9, open a saved report offline

Start only after the user approves Part B.

### Task 6: Worker routing and build pipeline

Role: integration.

**Files:**
- Create: `src/service-worker/routing.ts`, `src/service-worker/handlers.ts`, `src/service-worker/sw.ts`, `src/service-worker/tsconfig.json`, `scripts/build-sw.ts`
- Modify: `package.json`, `tsconfig.json` (exclude `src/service-worker/sw.ts`), `next.config.ts`, `.gitignore` (`public/sw.js`)
- Test: `tests/unit/service-worker/routing.test.ts`, `tests/unit/service-worker/handlers.test.ts`

**Interfaces:**
- Produces, in `routing.ts`, which is pure and DOM-free so Vitest can import it:
  - `type Route = { kind: "front"; locale: "et" | "en" } | { kind: "report"; locale: "et" | "en"; publicId: string } | { kind: "static" } | { kind: "pass" }`
  - `routeRequest(url: URL, origin: string, mode: RequestMode, method: string): Route`. `/` maps to front `et`.
  - `staticAssetsIn(html: string): string[]`, the unique `/_next/static/` paths from `src` and `href` attributes, without query strings.
  - `shellPaths(publicId: string): [string, string]`, which returns `/et/r/{id}` and `/en/r/{id}`.
  - `cacheName(buildVersion: string): string`, which returns `kontroll-offline-{buildVersion}`.
  - `SHELL_HEADER = "x-kontroll-offline-shell"`.
- Produces, in `handlers.ts`: `createWorkerHandlers(deps: { caches: CacheStorage; fetch: typeof fetch; origin: string; buildVersion: string; savedPublicIds: () => Promise<string[]> }): { install(): Promise<void>; activate(): Promise<void>; handleFetch(request: Request): Promise<Response> | null; handleMessage(data: unknown): Promise<{ ok: boolean }> }`. It uses only types shared with the DOM lib, so the root `tsc` and Vitest can import it. `handleFetch` returns null for a `pass` route.
- `sw.ts` is the thin entry point. It wires `self` events to `createWorkerHandlers` and reads `savedPublicIds` from IndexedDB. It is the only file excluded from the root `tsconfig.json` and checked by `src/service-worker/tsconfig.json` with `lib: ["webworker", "esnext"]`.
- Behavior:
  - Message protocol `{ type: "cache-shells"; publicId: string }` and `{ type: "remove-shells"; publicId: string }`. Each replies `{ ok: boolean }` on `event.ports[0]`.
  - Install reads `publicId`s from IndexedDB `kontroll-offline` and caches `/et`, `/en`, both shells for each saved report, and `staticAssetsIn` of each. Any failure rejects the install.
  - Activate deletes other `kontroll-offline-*` caches and claims clients.
  - Shells are fetched with `SHELL_HEADER: 1`.
- Scripts: `"build:sw": "tsx scripts/build-sw.ts"`. Also `"build": "npm run build:sw && next build --webpack"`, `"dev": "npm run build:sw && next dev"`, and `"typecheck": "next typegen && tsc --noEmit && tsc --noEmit -p src/service-worker"`. `build-sw.ts` bundles `sw.ts` with esbuild to `public/sw.js`, and defines `BUILD_VERSION` as the short git SHA plus `Date.now()`.
- `next.config.ts` headers for `/sw.js`: `Cache-Control: no-cache` and `Service-Worker-Allowed: /`.

- [ ] **Step 1: Write the failing tests.**
  - `routing.test.ts`: `page load of /en is front en`, `page load of / is front et`, `page load of /et/r/{uuid} is report`, `/et/r/not-a-uuid is pass`, `GET /_next/static/chunks/a.js is static`, `POST and other origins are pass`, `/api/analyses/x/report is pass`, `staticAssetsIn finds src and href assets and drops queries`, `shellPaths returns both locales`.
  - `handlers.test.ts`: call `createWorkerHandlers` with fake `caches` and `fetch`. Cases: `offline report load serves the cached shell`, `offline report load without a shell serves the cached front page of that locale`, `online report load returns the network response and caches nothing`, `install fails when one asset fails`, `activate deletes older kontroll-offline caches only`, `remove-shells deletes both shells for that publicId only`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/service-worker`. Expected: FAIL.
- [ ] **Step 3: Implement** `routing.ts`, then `handlers.ts`, then `sw.ts`, then the build script and config.
- [ ] **Step 4: Run** the gates and `npm run build`, then check that `public/sw.js` exists and `curl -sI localhost:3000/sw.js` under `npm run start` shows both headers.
- [ ] **Step 5: Commit** `feat(offline): add the report service worker`

### Task 7: Report shell and offline report view

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/features/offline/offline-report.tsx`, `src/features/report/offline-context.ts`
- Modify: `src/app/[locale]/r/[publicId]/page.tsx`, `src/features/report/report-view.tsx`, `src/features/report/evidence-image.tsx`, `messages/en.json`, `messages/et.json`
- Test: `tests/unit/offline/offline-report.test.tsx`, `tests/unit/report/report-view.test.tsx`, `tests/unit/report/report-page-shell.test.tsx`

**Interfaces:**
- Consumes: Task 2's `getSavedReport`. Task 6's `SHELL_HEADER`.
- Produces: `OfflineReport({ locale, publicId }: { locale: Locale; publicId: string })`. `OfflineContext`, a React context provided by `ReportView` when `offline` is true and read by `EvidenceImage`.

- [ ] **Step 1: Write the failing tests:**
  - `report-page-shell.test.tsx`: `with the shell header the page renders OfflineReport and never calls loadReport or reads the cookie`.
  - `offline-report.test.tsx`: `renders ReportView offline from the saved record`, `shows Saved on {date}. This copy may be out of date.`, `without a record says there is no saved copy and links to /{locale}`, `renders in Estonian`.
  - `report-view.test.tsx`: `offline hides retry and diagnostics`, `offline photos show Photo unavailable`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/offline tests/unit/report`. Expected: FAIL.
- [ ] **Step 3: Implement.** The page checks `(await headers()).get(SHELL_HEADER) === "1"` before any cookie read.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(offline): render a saved report from a data-free shell`

### Task 8: Worker registration and offline front page

Role: small implementation changes and focused tests.

**Files:**
- Create: `src/features/offline/worker-client.ts`, `src/features/offline/use-online.ts`, `src/features/offline/offline-worker-boot.tsx`
- Modify: `src/features/offline/save-report.ts`, `src/features/listing/submission-form.tsx`, `src/app/[locale]/page.tsx`, `src/app/[locale]/r/[publicId]/page.tsx`, `src/features/listing/messages.ts`, `src/app/[locale]/styles/offline.css`
- Test: `tests/unit/offline/worker-client.test.ts`, `tests/unit/offline/offline-front-page.test.tsx`

**Interfaces:**
- Consumes: Task 6's message protocol. Task 2's `listSavedReports`.
- Produces:
  - `ensureWorker(): Promise<ServiceWorkerRegistration | null>`. It registers `/sw.js` with scope `/`, and returns null when service workers are unsupported.
  - `cacheShells(publicId: string): Promise<boolean>` and `removeShells(publicId: string): Promise<boolean>`.
  - `releaseWorkerIfEmpty(): Promise<void>`. When no report is saved, it unregisters the worker and deletes the `kontroll-offline-*` caches.
  - `useOnline(): boolean`, built on `useSyncExternalStore` over `navigator.onLine` and the `online` and `offline` events. The server snapshot is `true`.
  - `OfflineWorkerBoot()`, which calls `ensureWorker` after mount when `listSavedReports` is non-empty. It is mounted on the front page and the report page.
  - `saveReport` calls `ensureWorker` and `cacheShells` after a write. `removeSavedReport` calls `removeShells`, then `releaseWorkerIfEmpty`.

- [ ] **Step 1: Write the failing tests:**
  - `worker-client.test.ts`: `ensureWorker registers /sw.js with scope /`, `ensureWorker returns null without serviceWorker`, `cacheShells posts cache-shells and resolves the reply`, `releaseWorkerIfEmpty unregisters only when nothing is saved`.
  - `offline-front-page.test.tsx`: `offline shows the notice and makes the form inert and aria-disabled`, `the online event restores the form`, `a submit failing with a network error shows the notice`, `renders the notice in Estonian`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/offline`. Expected: FAIL.
- [ ] **Step 3: Implement.** The notice copy is "You're offline. Checking a new listing needs a connection. Your saved reports below still open." Write its Estonian version in the plain style of the existing front page text. The greyed style comes from the prototype's `.proto-form-off`.
- [ ] **Step 4: Run the gates.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(offline): register the worker and show the offline front page`

### Task 9: Production offline test, acceptance and PR

Role: integration for Steps 1 to 3, then the coordinator, with manual frontend E2E and independent review from the agent policy.

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/offline.spec.ts`
- Modify: `package.json` (`@playwright/test`, `"test:e2e": "playwright test"`), `vitest.config.ts` (exclude `tests/e2e/**`), `docs/local-development.md`, `README.md`, `docs/superpowers/roadmap.md`

- [ ] **Step 1: Write** `tests/e2e/offline.spec.ts` against `npm run build && npm run start`, with `webServer` in the Playwright config. Seed one record by calling `putSavedReport` through `page.evaluate` with the report from `tests/fixtures/sample-report.ts`, then call `cacheShells`. Then call `context.setOffline(true)`. Tests:
  - `front page loads offline with the notice and the saved report listed`
  - `report address loads offline from the shell`
  - `every request after going offline is served by the worker`. Record `response.fromServiceWorker()` for each response.
  - `the en address of a report saved in et also loads offline`
- [ ] **Step 2: Run** `npx playwright install chromium && npm run test:e2e`. Expected: PASS.
- [ ] **Step 3: Document** in `docs/local-development.md` how to reach the app over HTTPS from a phone, for example `cloudflared tunnel --url http://localhost:3000`, and why phones need it.
- [ ] **Step 4: Manual E2E** in the internal browser, following the spec's checkpoint 9 "How to check" steps 1 to 8 and 10. Step 9, on real phones, is for the user. Save screenshots to `docs/superpowers/checkpoints/offline-9/`.
- [ ] **Step 5: Independent review**, plus the final review for privacy and concurrency from the agent policy (cached HTML without report data, install and activate races, removal during caching). Fix the findings and repeat the affected checks.
- [ ] **Step 6: Record** the evidence in `docs/superpowers/checkpoints/2026-10-17-offline-9.md`. In the roadmap, set checkpoint 9 to "PR open; user acceptance pending". Open the PR with the `/pr` skill and stop.
