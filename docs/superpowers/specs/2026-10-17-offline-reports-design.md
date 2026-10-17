# Offline reports design

Covers [roadmap checkpoints 8 and 9](../roadmap.md#checkpoint-8-save-a-report-on-this-device). The user made the decisions below on 2026-10-17.

## Goal

A buyer saves a private report on their phone before a viewing. At the viewing, with no signal, they open it from the front page or from its usual address.

## Decisions

| Question | Decision |
| --- | --- |
| Access rule | The access cookie lasts 30 days. A denial never deletes a saved copy. Only expiry and Remove delete one. |
| Finding a saved report offline | A "Saved on this device" list on the front page (`/et`, `/en`). No separate saved reports page. |
| Service worker | Hand-written in TypeScript, compiled with esbuild. No Serwist. |
| Expiry | 30 days after the last save or update. |
| Offline front page | The address form is greyed out and disabled, with a notice above it. |
| Build caches | One cache per build. See [Builds and updates](#builds-and-updates). |

The layout of the front page list comes from prototype variant A on branch `prototype/saved-reports`. Run it with `npm run dev` and open `/en?variant=A`. The prototype's `?offline=1` toggle shows the offline front page.

### Why the cookie lasts 30 days

`main` has no way to revoke access. The database sets `access_token_hash` once and never changes it. A 401 from the report API therefore means the browser lost its cookie, not that access ended. With a session cookie, a phone browser restart would leave an online buyer facing "access denied" while a saved copy exists. A 30-day cookie matches the saved copy's lifetime, so this does not happen.

## Checkpoint 8: Save a report on this device

No service worker. Everything works online only.

### Access cookie

- `POST /api/analyses/[publicId]/access` sets the cookie with `maxAge` of 30 days.
- New `PUT /api/analyses/[publicId]/access` renews the cookie for 30 days. It requires a cookie that passes `verifyAnalysisAccess` and the same origin check as the other write routes. It returns 401 otherwise and never deletes anything. It sets the same cookie value with a new `maxAge`.
- Save and Update call `PUT` before fetching the report. Reports opened before this change get a persistent cookie this way.

### Storage

- IndexedDB database `kontroll-offline`, store `reports`, key `publicId`.
- Record: `{ schemaVersion: 1, publicId, locale, report, savedAt, expiresAt, checklist: {} }`. `report` is the `AnalysisReport` from `GET /api/analyses/[publicId]/report`. `checklist` stays empty until the persistent viewing checklist from the backlog, which needs no migration.
- One module, `src/features/offline/saved-reports.ts`, owns the database. Its functions are `saveReport`, `getSavedReport`, `listSavedReports`, `removeSavedReport` and `subscribe`. All writes go through one ordered queue, the idea taken from the prototype's `report-cache.ts`.
- Reads validate with `AnalysisReportSchema`. A record that fails validation, has an unknown `schemaVersion` or has expired is deleted on read. Only that record is touched.
- Removing a report while a save of the same report is still fetching cancels the save. The record stays removed.
- Saving, updating or removing one report never touches another.
- `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES` replaces the 30 days when `NODE_ENV` is not `production`, for testing expiry. The cookie keeps its 30 days.
- `saveReport` calls `navigator.storage.persist()` once. A `QuotaExceededError` becomes a "storage is full" result the UI shows.
- `subscribe` notifies open tabs through `BroadcastChannel("kontroll-offline")`, so the front page list and a report page stay in sync.

### Report page: save strip

A strip above the report cards, rendered by a client component in `ReportView` when `offline` is false.

- Not saved: "Save on this device".
- Saved: "Saved on 17 Oct · kept until 16 Nov", Update and Remove.
- When the live report's `updatedAt` is later than the saved copy's, the strip says a newer version exists. Update replaces the copy and renews both the cookie and the expiry.
- Storage full shows its message in the strip.
- On iOS Safari outside Home Screen mode, the strip shows the 7-day deletion warning. Detect it with the iOS user agent and `navigator.standalone !== true`.
- Dates use `Intl.DateTimeFormat` with the page locale.

### Front page: saved list

Under the address form, as in prototype variant A.

- Heading "Saved on this device". Hidden when nothing is saved.
- One row per report, newest save first: the car title from `vehicleTitle(report)`, "Saved {date} · kept until {date}", an Open link to `/{locale}/r/{publicId}`, and Remove.
- The iPhone 7-day warning under the list, with the same detection as the strip.
- Rendered on the client after mount, so the server HTML stays the same for every visitor.

### Strings

Report page and offline report strings go under `Report.offline` in `messages/en.json` and `messages/et.json`. Front page strings go in `src/features/listing/messages.ts`, next to the existing front page text. Restore the wording from the prototype's ET/EN `Report.offline` strings where it fits.

### What you will see

A report page has a "Save on this device" button. After saving, it shows the save date, the expiry date, and Update and Remove. The front page lists every saved report.

### How to check

1. Open a report and press "Save on this device". The save date and "kept until" date appear.
2. Open the front page. The report is listed under "Saved on this device".
3. Save a second report. Remove the first from the front page. The second is still listed and still shows as saved on its own page.
4. Add a seller answer to a saved report and wait for the review to finish. The strip says a newer version exists. Press Update. The notice goes away and the save date changes.
5. Set `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES=2` in `.env.local`, restart, save a report, wait 3 minutes and reload the front page. The report is gone.
6. Clear the site's cookies in DevTools, then open a saved report's address. It asks for the private link, and the saved copy is still on the front page.
7. Quit and reopen the browser, then open a report you saved. It opens without the private link.
8. Repeat steps 1 to 4 in Estonian.

## Checkpoint 9: Open a saved report offline

### Worker

- Source `src/service-worker/sw.ts` with `lib: ["webworker"]`. Script `build:sw` compiles it with esbuild into `public/sw.js`, and defines `BUILD_VERSION` from the git commit plus a timestamp. `public/sw.js` is in `.gitignore`.
- `build:sw` runs before `next build`, before `next dev`, and in `typecheck`. Add `esbuild` as a direct devDependency.
- `next.config` serves `/sw.js` with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`.
- Registered with scope `/` after a save, and on any front page or report page load while at least one report is saved. When the last saved report is removed, the page unregisters the worker and deletes its caches.

### Requests the worker handles

The worker calls `respondWith` only for these. Every other request, including all `/api/` calls, goes to the network untouched.

| Request | Online | Offline |
| --- | --- | --- |
| Page load of `/`, `/et`, `/en` | Network | Cached front page (`/` serves `/et`) |
| Page load of `/{l}/r/{publicId}` | Network. The response is never cached. | That report's cached shell, or the front page if none |
| `GET /_next/static/*` | Current build's cache first, then network. A network response is added to the current build's cache. | Current build's cache |

### Report shell

- The report page returns a shell when the request has the header `x-kontroll-offline-shell: 1`. The shell has the site header and a client component, `OfflineReport`. It reads no cookie and contains no report data.
- The worker fetches and caches the shell at the report's own address, so the cached HTML matches its URL and Next's router hydrates normally. This is the prototype's approach.
- `OfflineReport` loads the record from IndexedDB by `publicId` and renders `ReportView` with `offline`. Above the cards it shows "Saved on {date}. This copy may be out of date." With no record, it says there is no saved copy and links to the front page.
- Photos show "Photo unavailable" in place of the image when `offline` is set.
- `ReportView` with `offline` already hides refresh, the evidence row, the supplement dialog and Seller replied. Check that retry and diagnostics stay hidden too.

### Builds and updates

- Cache name `kontroll-offline-{BUILD_VERSION}`.
- On install, the worker reads the saved `publicId`s from IndexedDB. It caches `/et`, `/en` and one shell per saved report, plus every `/_next/static/` file referenced in their HTML. If any of these fail, the install fails and the old worker keeps serving.
- On activate, it deletes every other `kontroll-offline-*` cache and claims clients.
- After a save, the page asks the worker by `postMessage` to cache that report's shell. After a remove, it asks the worker to delete it.

The roadmap asked for one cache per build, kept until no saved report needs that build. Saved reports are data in IndexedDB, not cached HTML, so the newest build renders reports saved under any build. A record with an older `schemaVersion` is migrated on read, or the page asks for an Update online. One cache, for the build the worker belongs to, is enough.

### Offline front page

- The page tracks connection state from `navigator.onLine` and the `online` and `offline` events.
- Offline: a notice above the form reads "You're offline. Checking a new listing needs a connection. Your saved reports below still open." The form is greyed out, `inert` and `aria-disabled`.
- A submit that fails with a network error shows the same notice.
- Back online: the notice goes away and the form works.

### Tests

- Unit tests for the worker's request routing, install failure, cache cleanup on activate, and the shell and remove messages.
- One Playwright test against `npm run build && npm run start`: save a report, go offline with `context.setOffline(true)`, open the report address and the front page, and check that every request is served from the cache.

### What you will see

With no connection, the front page opens with the form greyed out and the saved reports listed. A saved report opens from the list or from its address, with the save date and a note that it may be out of date.

### How to check

1. Run `npm run build` and `npm run start`.
2. Save a report. In DevTools, turn on offline mode.
3. Open the front page. The offline notice shows, the form is greyed out, and the saved report is listed.
4. Open the report from the list. It loads with the save date and the out-of-date note. Photos say "Photo unavailable". No upload, retry or diagnostics controls.
5. Open the report by typing its address. It loads the same way.
6. Close and reopen the browser while still offline. Repeat steps 3 and 5.
7. Go online, rebuild and restart the app, open the front page once, then go offline and repeat step 5.
8. Turn offline mode off. The notice goes away and the form works.
9. Repeat on an iPhone with Safari and an Android phone with Chrome over HTTPS, as described in `docs/local-development.md`. Use airplane mode.
10. Repeat steps 3 to 5 in Estonian.

## Out of scope

Offline photos, offline taustakontroll PDFs and the persistent viewing checklist stay in the [deferred backlog](../roadmap.md#deferred-backlog).
