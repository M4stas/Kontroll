# Roadmap

Planned work that is not yet implemented. Finished work lives in [archive](archive/README.md).

Each checkpoint ends with a change you can see in the running app. After a checkpoint, run the app, follow its check steps, and then decide whether to approve the next one. Checkpoint numbers here follow roadmap order. The live diagnostics plan uses its own checkpoint numbers, and the Source column maps them.

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| 1 | Photo preparation timings | How long each photo took to download, check, normalize and upload, in the report's diagnostics drawer | [Draft PR #22](https://github.com/M4stas/kontroll/pull/22); user acceptance pending | [Diagnostics plan checkpoint 2](plans/2026-10-09-live-diagnostics.md#checkpoint-2-detailed-capture-timings), application part |
| 2 | Auto24 capture timings | Capture phases on the listing page, before the report exists | Planned, not approved | [Diagnostics plan checkpoint 2](plans/2026-10-09-live-diagnostics.md#checkpoint-2-detailed-capture-timings), extraction part |
| 3 | Save a report on this device | Save, update and remove buttons on a report, with the saved date | Needs a spec | This file |
| 4 | Open a saved report offline | A saved report opening in airplane mode | Needs a spec | This file |
| 5 | PDF processing and reassessment | PDF processing times and the previous and current final results after a taustakontroll upload | Planned, not approved | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| 6 | Earlier runs and timing export | A run picker and a downloadable timing file | Only if checkpoints 1 and 2 show a need | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |

The [human model-quality review](#alongside-the-checkpoints-human-model-quality-review) is your task and can happen at any time. Unscheduled work is in the [deferred backlog](#deferred-backlog).

Offline saving does not depend on live diagnostics. It comes before checkpoints 5 and 6 because it helps buyers at viewings, while diagnostics only helps developers.

## How each checkpoint works

- Work on a checkpoint starts only after you approve it. Finishing one checkpoint does not approve the next.
- Each checkpoint gets its own PR. It is done when its automated checks pass, an independent review is clean, and you have run the app and seen the result it describes.
- Run the app as described in [local development](../local-development.md).
- Diagnostics checkpoints need `LIVE_DIAGNOSTICS_ENABLED=true` in `.env.local`.
- Offline checkpoints need a production build, with `npm run build` and then `npm run start`. The Next.js offline guide says dev mode is not reliable for offline behavior.

## Alongside the checkpoints: human model-quality review

Only an AI has graded the reviewer models so far. The checkpoint 2 comparison of `gpt-6.1-sol` and `gpt-6-luna` used synthetic listings, and its photo case used a drawn wheel instead of a real car photo. The [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) lists human model-quality signoff as open.

1. Run a model comparison and score the side-by-side sheet, following [human scoring](../reviewer-evaluation-guide.md#human-scoring) in the reviewer evaluation guide.
2. Read at least one real report from start to end, such as the October 3 Passat report in the checkpoint 2 analysis. The synthetic cases do not establish ground truth. Check whether the findings are true for that car, whether the report missed something obvious, and whether the seller questions are worth asking. Pick a report with real listing photos, because no test has checked damage recognition on real photos yet.
3. Record the scores, the notes, and the chosen reviewer model, and link them from this file.

## Checkpoint 1: Photo preparation timings

Implemented in October 2026; user app acceptance is pending. [Verification evidence](checkpoints/2026-10-10-photo-preparation-timings.md). Scoped [implementation and overhead acceptance](plans/2026-10-10-photo-preparation-timings.md). Existing capture uploads normalize image metadata; reviewer PNG preparation performs resizing. Labels must describe the measured work without changing image processing.

### Before starting

Update the [live diagnostics plan](plans/2026-10-09-live-diagnostics.md) to match this roadmap:

- Fix the base branch in its global constraints. It still says to start from a descendant of `codex/image-review-performance`, which merged in PR #13.
- Split its checkpoint 2 into roadmap checkpoints 1 and 2, and its checkpoint 3 into roadmap checkpoints 5 and 6.
- Set a maximum added time for diagnostics-enabled runs. The plan asks to measure the overhead but sets no limit. Each diagnostics checkpoint fails if a measurement exceeds the limit.

### What you will see

Open Live diagnostics on a report that has listing photos and expand a photo. It shows how long the download, check, normalization and upload took, and how long reviewer preparation took. Time spent waiting in a queue or before a retry is separate from work time, or explicitly marked unavailable when it cannot be measured. Reports made before this checkpoint show "Not recorded" for these timings.

### How to check

1. Start the app and the worker with diagnostics enabled.
2. Submit an Auto24 listing, open the report, and open Live diagnostics.
3. Expand a photo and read its timings.
4. Open a report made before this checkpoint. The drawer shows "Not recorded" and does not fail.
5. Check the recorded five controlled four-photo comparisons with diagnostics on and off. Each enabled run adds at most 500 ms, and both runs make the same number of reviewer calls. These comparisons use generated photos and a fake reviewer, without extra live listing or model calls.

### Scope

Additive Supabase timing storage, best-effort collectors in the application and worker that never block a review, photo preparation and reviewer preparation timings, and a nested timeline in the report drawer. No extraction service changes.

## Checkpoint 2: Auto24 capture timings

### What you will see

Submit an Auto24 link and open Live diagnostics on the listing page right away, before the report exists. Capture phases appear as they finish: queue wait, browser start, page load, HTML retrieval and validation, parsing, browser shutdown, and saving the result. The finished report's drawer shows the same capture timings above the photo timings from checkpoint 1.

### How to check

1. Rebuild and restart the extraction service containers, then start the app and the worker.
2. Submit a listing and open the drawer on the listing page.
3. Watch the phases appear, then open the report and find the same capture timings.
4. Check a capture with a failed and retried phase, and a capture where timing storage is unavailable. The drawer shows what it could not measure, and the capture still completes.
5. Open a listing captured before this checkpoint. It still works and shows "Not recorded".
6. Repeat the overhead comparison from checkpoint 1.

### Scope

Additive Turso timing storage in the extraction service, Auto24 phase instrumentation, the listing diagnostics endpoint, the drawer on the listing page, and the link from a capture to its report.

## Checkpoint 3: Save a report on this device

### Before starting

Write the offline spec. It must:

- Choose the [access rule](#access-rule).
- Decide how a buyer finds a saved report without a connection: browser history, a bookmark, or a list of saved reports inside the worker scope.
- Choose between a hand-written service worker and Serwist. The [Next.js PWA guide](#offline-saving-background) suggests Serwist, which adds a dependency.

### What you will see

A report page has a button to save the report on this device. After saving, the page shows the save date and buttons to update or remove the saved copy. When the server has a newer version than the saved copy, the page says so. Nothing works offline yet. That comes in checkpoint 4.

### How to check

1. Open a report and save it. The save date appears.
2. Save a second report, remove the first, and check that the second still shows as saved.
3. Add a seller answer to a saved report. The page says a newer version exists, and the update button replaces the saved copy.
4. With a short expiry set for development, check that an expired copy is removed.
5. Check the chosen access rule. For example, clear the site's cookies, open the report again, and confirm the saved copy behaves as the rule says.
6. Repeat the checks in Estonian.

### Scope

An IndexedDB store with one record per `publicId`, a schema version, an expiry date, and room for viewing checklist marks so the checklist can come later without a data migration. The save, update and remove buttons, the save date, the newer-version notice, the chosen access rule, and ET/EN strings. Saving, updating, removing or deleting one report never touches another. Automated tests cover a removal while a fetch for that report is still running. No service worker yet.

## Checkpoint 4: Open a saved report offline

### What you will see

With no connection, a saved report opens from its usual address. It shows the save date and says the copy may be out of date. Photos show "photo unavailable". The refresh, diagnostics, upload and retry controls are hidden.

### How to check

1. Run a production build.
2. Save a report, then turn on airplane mode or offline mode in DevTools.
3. Open the report's address. It loads from the saved copy.
4. Close and reopen the browser while still offline, then open the report again.
5. Save a report, deploy a new build, go offline, and open the report.
6. Repeat on iOS Safari and on Chrome for Android. Service workers need HTTPS on any address other than `localhost`, so a phone needs an HTTPS address, such as a tunnel or a local certificate.

WebKit's tracking prevention can delete a site's stored data after 7 days of Safari use without a visit to that site, unless the user added the site to the home screen. A report saved a week before a viewing can disappear. The page should tell iPhone users about this.

### Scope

- Register the service worker twice, with scopes `/et/r/` and `/en/r/`. Scopes are URL path prefixes, not patterns. Requests from a controlled page, such as `/_next/static/` files, still reach the worker.
- Never cache the server-rendered report page. `src/app/[locale]/r/[publicId]/page.tsx` puts report data into its HTML. Add a client-side offline page that reads the saved record from IndexedDB and renders `ReportView` with `offline` set.
- The `offline` prop in `src/features/report/report-view.tsx` already hides the refresh, the diagnostics panel and both upload forms. Also hide `RetryReview`, which still shows for incomplete reports.
- Keep the cached page and its `/_next/static/` files together per build. Remove them once no saved report needs that build.
- Call `navigator.storage.persist()`. Show a clear message when storage is full.

## Checkpoint 5: PDF processing and reassessment

### What you will see

Upload a taustakontroll PDF on a finished report and open Live diagnostics. The drawer shows how long validation, text extraction and upload took, then the new final assessment. It shows the previous and current final results, and marks text and photo results that were reused from the earlier run.

### How to check

1. Upload a PDF on a finished report and open the drawer.
2. Check that exactly one new final assessment runs, and that reused results keep their original times.
3. Upload a file the app rejects. No new run appears.
4. Repeat the overhead comparison from checkpoint 1.

### Scope

PDF processing timings tied to accepted uploads, the PDF update and reuse view, and the previous and current final results. Results are compared as written. The drawer does not classify changes as added, changed or removed.

## Checkpoint 6: Earlier runs and timing export

Approve this checkpoint only if checkpoints 1 and 2 show that developers need run history or an export.

### Before starting

Decide whether the export contains every paginated record or lists the records it left out.

### What you will see

The drawer has a picker that lists earlier runs, page by page. A download button saves a timing-only JSON file.

### How to check

1. Switch runs while one is still loading. Results never appear under the wrong run.
2. Download the export and open it. It has durations, counts and settings. It has no findings, document text, photos, URLs or secrets.

### Scope

The earlier-run picker with pagination and the timing-only JSON export.

## Offline saving background

A buyer can open a saved private report at a viewing without a connection. `main` has no offline saving today. `README.md` and `docs/local-development.md` say so.

Before writing the spec, read the Next.js 16.3.8 guides `offline-support.md` and `progressive-web-apps.md` in `node_modules/next/dist/docs/01-app/02-guides/`. The experimental `useOffline` covers in-app navigation only. Opening a page from scratch without a connection still needs a service worker.

### Prototype

Write the feature fresh. Use the branch `codex/used-car-prototype` only as reference. Its offline code is in commits `5962ce8`, `f86e2ad` and `2398ea9` under `src/features/offline/`, plus `public/sw.js` and `tests/unit/offline/`.

A review on 2026-10-10 found these problems with reusing the prototype code:

- Its service worker matches `/(et|en)/a/<uuid>`. On `main`, `/a/` is the listing dashboard and reports live at `/r/`.
- It never deletes a saved report after an access denial. The [access rule](#access-rule) explains what a denial means on `main`.
- Saving one report clears every other saved report, and records carry no schema version.
- Only `/_next/static/` is cached, so photos and taustakontroll PDFs would be missing offline.
- The worker registers at scope `/` and serializes every static asset request.

Worth reading in the prototype: the ordered IndexedDB write queue and validation on read in `report-cache.ts`, the shell-only caching that keeps report data out of cached HTML, the race tests where a clear runs during a fetch, and the ET/EN `Report.offline` strings that PR #16 removed from `main`.

### Access rule

An earlier version of this file said to delete the saved copy on any 401 or 403 response. That rule does not match how access works on `main`:

- The access cookie set in `src/app/api/analyses/[publicId]/access/route.ts` has no `maxAge`. Browsers drop it when the session ends.
- `main` has no way to revoke access. The database sets `access_token_hash` when it creates a report and never changes it.
- A 401 from the report API therefore usually means the browser lost its cookie. If a phone browser restarts and the buyer opens the saved report online, the old rule would delete the copy they need.
- A 403 means a failed origin check on a POST route. It says nothing about access to the report.

The spec must choose one of these:

- Make the access cookie persistent, with a lifetime at least as long as a saved copy's expiry.
- Have the report API tell "no cookie" apart from "cookie rejected", and delete the saved copy only on a rejection.
- Never delete on a denial. Rely on expiry and the remove button.

Any deletion removes only the affected report and its files. A device without a connection cannot learn about lost access until it reconnects.

## Deferred backlog

These items are not scheduled. When one is scheduled, give it a checkpoint with a visible result and check steps like the ones above. The table lists what each item depends on and what it needs beyond your approval.

| Item | Depends on | Also needs | Source |
| --- | --- | --- | --- |
| Offline photos | Checkpoint 4 | Access-checked caching, because the image API returns `private, no-store`. A size limit per report. | This file |
| Offline taustakontroll PDFs | Offline photos | The same access-checked caching, with more storage | This file |
| Persistent viewing checklist | Checkpoint 3 record format | Nothing extra | [checkpoint 4 release](archive/report-checkpoints/checkpoint-4-release.md), [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Grouped findings | Nothing | Must keep every per-pass observation that the checkpoint 2 contract preserves | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| Transpordiamet summary | Nothing | Authorized access to the source. Ordinary service code, with no extra AI summarizer. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Factory manual excerpts | Nothing | Its own scoping for retrieval. Keep the manual version, vehicle match, and page references. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Paid VIN lookup | Late in development | A paid provider account and an explicit purchase flow. The reviewer cannot start purchases. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
