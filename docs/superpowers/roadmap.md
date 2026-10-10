# Roadmap

Planned work that is not yet implemented. Each item needs the user's approval before work starts. Finished work lives in [archive](archive/README.md).

| Order | Item | Status | Source |
| --- | --- | --- | --- |
| 1 | Human model-quality review | Open, done by the user | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| 2 | Live diagnostics plan update | Needed before checkpoint 2 | This file |
| 3 | Live diagnostics checkpoint 2: detailed capture timings | Planned, not approved | [plan](plans/2026-10-09-live-diagnostics.md#checkpoint-2-detailed-capture-timings) |
| 4 | Offline report saving, text only | Needs a spec | This file |
| 5 | Live diagnostics checkpoint 3a: PDF reassessment | Planned, not approved | [plan](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| 6 | Live diagnostics checkpoint 3b: earlier runs and export | Only if checkpoint 2 shows a need | [plan](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |

The order is a suggestion. The user can do item 1 at any time, alongside the other items. Offline saving does not depend on live diagnostics, so its spec can be written while checkpoint 2 is built. Offline saving comes before checkpoint 3 because it helps buyers at viewings, while diagnostics only helps developers.

Unscheduled work is in the [deferred backlog](#deferred-backlog).

## Human model-quality review

Only an AI has graded the reviewer models so far. The checkpoint 2 comparison of `gpt-6.1-sol` and `gpt-6-luna` used synthetic listings, and its photo case used a drawn wheel instead of a real car photo. The checkpoint 2 analysis lists human model-quality signoff as open.

1. Run a model comparison and score the side-by-side sheet, following [human scoring](../reviewer-evaluation-guide.md#human-scoring) in the reviewer evaluation guide.
2. Read at least one real report from start to end, such as the October 3 Passat report in the checkpoint 2 analysis. The synthetic cases do not establish ground truth. Check whether the findings are true for that car, whether the report missed something obvious, and whether the seller questions are worth asking. Pick a report with real listing photos, because no test has checked damage recognition on real photos yet.
3. Record the scores, the notes, and the chosen reviewer model, and link them from this file.

## Live diagnostics

The [design](specs/2026-10-09-live-diagnostics-design.md) and [plan](plans/2026-10-09-live-diagnostics.md) describe the remaining checkpoints. Checkpoint 1 shipped in PR #14.

### Plan update before checkpoint 2

- Fix the base branch in the plan's global constraints. It still says to start from a descendant of `codex/image-review-performance`, which merged in PR #13.
- Set a maximum added time for diagnostics-enabled runs. The plan asks to measure the overhead but sets no limit. Checkpoint 2 fails if a measurement exceeds the limit.
- Split checkpoint 3 into 3a and 3b, as described below. The split keeps the architecture and makes each review smaller.

### Checkpoint 2

Checkpoint 2 adds timing storage and Auto24 capture instrumentation. A developer can then see which capture phase or photo caused a wait, including time spent before the report existed.

### Checkpoint 3a: PDF reassessment

Checkpoint 3a adds processing timings for accepted taustakontroll PDF uploads, the PDF update and reuse view, and the previous and current final results for that update.

### Checkpoint 3b: earlier runs and export

Checkpoint 3b adds the earlier-run picker with pagination and the timing-only JSON export. Approve it only if checkpoint 2 shows that developers need history or export. The spec must say whether the export contains every paginated record or lists the records it left out.

## Offline report saving

A buyer can open a saved private report at a viewing without a connection. `main` has no offline saving today. `README.md` and `docs/local-development.md` say so.

### Approach

Write the feature fresh. Use the branch `codex/used-car-prototype` only as reference. Its offline code is in commits `5962ce8`, `f86e2ad` and `2398ea9` under `src/features/offline/`, plus `public/sw.js` and `tests/unit/offline/`.

A review on 2026-10-10 found these problems with reusing the prototype code:

- Its service worker matches `/(et|en)/a/<uuid>`. On `main`, `/a/` is the listing dashboard and reports live at `/r/`.
- It never deletes a saved report after an access denial. The [access rule](#access-rule) explains what a denial means on `main`.
- Saving one report clears every other saved report, and records carry no schema version.
- Only `/_next/static/` is cached, so photos and taustakontroll PDFs would be missing offline.
- The worker registers at scope `/` and serializes every static asset request.

Worth reading in the prototype: the ordered IndexedDB write queue and validation on read in `report-cache.ts`, the shell-only caching that keeps report data out of cached HTML, the race tests where a clear runs during a fetch, and the ET/EN `Report.offline` strings that PR #16 removed from `main`.

### First release

Save text only. The saved copy holds the report data and the app files needed to show it, without photos or taustakontroll PDFs. Photo slots show the "photo unavailable" text that `EvidenceImage` already uses. A text-only copy is the smallest change and the cheapest to maintain. Photos and PDFs are in the [deferred backlog](#deferred-backlog).

### Access rule

Decide this before the rest of the spec.

An earlier version of this file said to delete the saved copy on any 401 or 403 response. That rule does not match how access works on `main`:

- The access cookie set in `src/app/api/analyses/[publicId]/access/route.ts` has no `maxAge`. Browsers drop it when the session ends.
- `main` has no way to revoke access. The database sets `access_token_hash` when it creates a report and never changes it.
- A 401 from the report API therefore usually means the browser lost its cookie. If a phone browser restarts and the buyer opens the saved report online, the old rule would delete the copy they need.
- A 403 means a failed origin check on a POST route. It says nothing about access to the report.

Choose one of these:

- Make the access cookie persistent, with a lifetime at least as long as a saved copy's expiry.
- Have the report API tell "no cookie" apart from "cookie rejected", and delete the saved copy only on a rejection.
- Never delete on a denial. Rely on expiry and the remove control.

Any deletion removes only the affected report and its files. A device without a connection cannot learn about lost access until it reconnects.

### Saved copy lifecycle

- The report page has controls to save for offline, update the saved copy, and remove the saved copy. Nothing is saved without the user's action.
- The page shows when the copy was saved. When the device is offline, or the server has a newer version, the page says the copy may be out of date.
- Each report is stored under its own `publicId`. Saving, updating, removing or deleting one report never touches another.
- Records carry a schema version and an expiry date. The format reserves room for viewing checklist marks, so the checklist can come later without a data migration.

### Technical requirements

- Read the Next.js 16.3.8 guides `offline-support.md` and `progressive-web-apps.md` in `node_modules/next/dist/docs/01-app/02-guides/`. The experimental `useOffline` covers in-app navigation only. Opening a page from scratch without a connection still needs a service worker. Choose between a hand-written worker and Serwist, which the PWA guide suggests and which adds a dependency.
- Register the worker twice, with scopes `/et/r/` and `/en/r/`. Scopes are URL path prefixes, not patterns. Requests from a controlled page, such as `/_next/static/` files, still reach the worker.
- Never cache the server-rendered report page. `src/app/[locale]/r/[publicId]/page.tsx` puts report data into its HTML. Add a client-side offline page that reads the saved record from IndexedDB and renders `ReportView` with `offline` set.
- The `offline` prop in `src/features/report/report-view.tsx` already hides the refresh, the diagnostics panel and both upload forms. Also hide `RetryReview`, which still shows for incomplete reports.
- Keep the cached page and its `/_next/static/` files together per build. Remove them once no saved report needs that build.
- Call `navigator.storage.persist()`. Show a clear message when storage is full.

### Tests

- Restart the browser with no connection, then open a saved report.
- Restart the browser with a connection, then open a saved report. The result must follow the access rule.
- Save two reports, remove one, and check that the other remains.
- Let a saved copy expire.
- Remove a saved copy while a fetch for it is still running.
- Deploy a new build between saving and viewing.
- Test on iOS Safari and Chrome on Android. WebKit's tracking prevention can delete a site's stored data after 7 days of Safari use without a visit to that site, unless the user added it to the home screen. A report saved a week before a viewing can disappear.

## Deferred backlog

These items are not scheduled. Each one needs the user's approval like everything else in this file. The table lists what each item depends on and what it needs beyond approval.

| Item | Depends on | Also needs | Source |
| --- | --- | --- | --- |
| Offline photos | Text-only offline release | Access-checked caching, because the image API returns `private, no-store`. A size limit per report. | This file |
| Offline taustakontroll PDFs | Offline photos | The same access-checked caching, with more storage | This file |
| Persistent viewing checklist | Offline saved-record format | Nothing extra | [checkpoint 4 release](archive/report-checkpoints/checkpoint-4-release.md), [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Grouped findings | Nothing | Must keep every per-pass observation that the checkpoint 2 contract preserves | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| Transpordiamet summary | Nothing | Authorized access to the source. Ordinary service code, with no extra AI summarizer. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Factory manual excerpts | Nothing | Its own scoping for retrieval. Keep the manual version, vehicle match, and page references. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Paid VIN lookup | Late in development | A paid provider account and an explicit purchase flow. The reviewer cannot start purchases. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
