# Roadmap

Planned work that is not yet implemented. Finished work lives in [archive](archive/README.md), including the [photo preparation timings](archive/photo-preparation-timings/checkpoint.md) from PR #22.

Each checkpoint ends with a change you can see in the running app. After a checkpoint, run the app, follow its check steps, and then decide whether to approve the next one. Checkpoint numbers here follow roadmap order. The redesign and live diagnostics plans use their own checkpoint numbers, and the Source column maps them.

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| 1 | New look across the app | Geist, the new palette, pill controls and one shared header on every page, in light or dark mode | Merged into `redesign` in PR #23 | [Redesign checkpoint 1 plan](plans/2026-10-11-redesign-checkpoint-1.md) |
| 2 | Start page and listing page | The start page hero with a pill address bar, and the listing page as a quick check with a large photo, a sticky card and a closed details section | PR #24; accepted by the user on 2026-10-12 | [Redesign checkpoint 2 plan](plans/2026-10-11-redesign-checkpoint-2.md) |
| 3 | Report cards | The report as a row of cards: cover, findings, seller message and viewing checklist | Planned, not approved | [Redesign plan checkpoint 3](plans/2026-10-10-redesign.md#checkpoint-3-report-cards) |
| 4 | Full report and evidence row | An add-evidence row and a closed full report section under the cards | Planned, not approved | [Redesign plan checkpoint 4](plans/2026-10-10-redesign.md#checkpoint-4-full-report-and-the-evidence-row) |
| 5 | Review step | Bars and photos following the review progress, then an "Open the report" button that shows the cards | Planned, not approved | [Redesign plan checkpoint 5](plans/2026-10-10-redesign.md#checkpoint-5-report-progress-screen-and-design-record) |
| 6 | Phone layouts | The redesigned pages laid out for phones | Needs a design | This file |
| 7 | Auto24 capture timings | Capture phases on the listing page, before the report exists | Planned, not approved | [Diagnostics plan checkpoint 2](plans/2026-10-09-live-diagnostics.md#checkpoint-2-detailed-capture-timings), extraction part |
| 8 | Save a report on this device | Save, update and remove buttons on a report, with the saved date | Needs a spec | This file |
| 9 | Open a saved report offline | A saved report opening in airplane mode | Needs a spec | This file |
| 10 | PDF processing and reassessment | PDF processing times and the previous and current final results after a taustakontroll upload | Planned, not approved | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| 11 | Earlier runs and timing export | A run picker and a downloadable timing file | Only if the photo timings and checkpoint 7 show a need | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |

The [human model-quality review](#alongside-the-checkpoints-human-model-quality-review) is your task and can happen at any time. Unscheduled work is in the [deferred backlog](#deferred-backlog).

The redesign comes first. The offline checkpoints build on its report layout, and the persistent viewing checklist needs its checklist card.

Offline saving does not depend on live diagnostics. It comes before checkpoints 10 and 11 because it helps buyers at viewings, while diagnostics only helps developers.

## How each checkpoint works

- Work on a checkpoint starts only after you approve it. Finishing one checkpoint does not approve the next.
- Each checkpoint gets its own PR. Redesign checkpoints 1 to 5 open their PRs against the `redesign` branch, and after checkpoint 5 one PR merges `redesign` into `main`. A checkpoint is done when its automated checks pass, an independent review is clean, and you have run the app and seen the result it describes.
- Run the app as described in [local development](../local-development.md).
- Redesign checkpoints 1 to 5 are designed and checked at desktop width, and use the same numbers as the redesign plan. At 390px every page must still work without sideways scrolling. Phone layouts come in checkpoint 6.
- The approved redesign demo is in `demos/redesign/final/`. The [redesign spec](specs/2026-10-10-redesign-design.md) explains how to serve it.
- Diagnostics checkpoints need `LIVE_DIAGNOSTICS_ENABLED=true` in `.env.local`.
- Offline checkpoints need a production build, with `npm run build` and then `npm run start`. The Next.js offline guide says dev mode is not reliable for offline behavior.

## Alongside the checkpoints: human model-quality review

Only an AI has graded the reviewer models so far. The checkpoint 2 comparison of `gpt-6.1-sol` and `gpt-6-luna` used synthetic listings, and its photo case used a drawn wheel instead of a real car photo. The [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) lists human model-quality signoff as open.

1. Run a model comparison and score the side-by-side sheet, following [human scoring](../reviewer-evaluation-guide.md#human-scoring) in the reviewer evaluation guide.
2. Read at least one real report from start to end, such as the October 3 Passat report in the checkpoint 2 analysis. The synthetic cases do not establish ground truth. Check whether the findings are true for that car, whether the report missed something obvious, and whether the seller questions are worth asking. Pick a report with real listing photos, because no test has checked damage recognition on real photos yet.
3. Record the scores, the notes, and the chosen reviewer model, and link them from this file.

## Checkpoint 1: New look across the app

### Before starting

- Run `git status`. Impeccable live mode can leave a `localhost:8400` script tag in `src/app/[locale]/layout.tsx` and a variants block in `src/app/[locale]/page.tsx`. If either is there, ask the user before discarding it, and never commit the live script.
- Commit `demos/redesign/final/`, `PRODUCT.md`, the spec and the redesign plan on the checkpoint branch, after the user agrees, so reviewers can open the demo.

### What you will see

Every page (start page, listing page and report) uses Geist, the new grey and white palette with a blue accent, pill-shaped buttons and inputs, and one shared header with the new logo mark and an ET/EN switch. Pages follow the computer's light or dark setting. Page layouts do not change yet.

### How to check

1. Start the app as described in [local development](../local-development.md) and open `/et`. The header shows the logo mark, "Kontroll", "New listing" and ET/EN. Text is in Geist, not Arial.
2. Switch the computer between light and dark mode, or use DevTools Rendering to emulate `prefers-color-scheme`. The page changes theme without a reload.
3. Submit an Auto24 listing. The listing page and the report use the same header and colors in both themes.
4. On the report, the ET/EN switch opens the same report in the other language.
5. Press Tab through the start page. Every control shows a focus ring.
6. Open an Estonian report. Letters such as õ, ä, š and ž render in Geist, with no fallback glyphs.
7. Open a report whose review stopped or a capture that failed. The error text stands out in the attention color.

### Scope

Tokens, Geist and Geist Mono through `next/font`, light and dark themes, one shared header, and pill controls and soft panels on every existing page. Layouts stay as they are. Steps for Codex agents are in the [checkpoint 1 plan](plans/2026-10-11-redesign-checkpoint-1.md).

## Checkpoint 2: Start page and listing page

### What you will see

The start page has a large left-aligned headline, the intro text and one pill-shaped address bar with the submit button inside it. The manual-entry option sits below. There is no photo.

The listing page has two columns. The left column shows the vehicle title and source, a three-step progress bar (Request received, Reading the listing, Details ready), the photos in a grid that fills in when the details arrive, then the description, equipment and technical details. The right column has a card that stays in view while you scroll, with the key facts and the button that starts the inspection report.

### How to check

1. Open `/et` and `/en`. The headline, intro and address bar show, with no photo.
2. Submit "not a link". The error shows under the bar in the attention color, and the field is marked invalid.
3. Press "Continue manually". The manual form opens below.
4. Submit a real Auto24 link. On the listing page the steps advance, and grey photo placeholders turn into the listing photos.
5. Scroll down. The facts card stays visible, and its "Open inspection report" button opens the report.
6. Open a capture that failed. The reading step shows in the attention color, with the existing failure message and the link to try another listing.
7. Repeat in dark mode and in Estonian.

### Scope

The start page hero without a photo, and the listing page as a quick check: a large photo with thumbnails, a sticky card with the key figures and the report button, and a closed "All listing details" section. The first version used capture steps; the user replaced it on 2026-10-11 (spec decisions 6 to 8). Accepted on 2026-10-12. Steps for Codex agents are in the [checkpoint 2 plan](plans/2026-10-11-redesign-checkpoint-2.md).

## Checkpoint 3: Report cards

### What you will see

A report opens as a row of large cards. Move through them with Back and Next, the arrow keys, or a trackpad swipe:

- A cover with the verdict, the car's first photo and how many things to check.
- One card per main finding, with its photo or an area icon on the left, and on the right what was found and where it came from.
- A "Send it in one message" card with the seller message and a copy button.
- An "At the viewing" card where you tick off checks.

The older sections (all checks, sources, upload forms) still sit below the cards, in the new colors, until checkpoint 4.

### How to check

1. Open a complete report. The cover shows the vehicle line, the verdict, "N things to check before you go", the status and the confidence.
2. Move with Next and Back, with the arrow keys after clicking into the cards, and with the progress strip above them. The Next button names the next card.
3. Finding cards have no "next check" box. Their source line opens the evidence dialog with the photo or the quoted text.
4. The message card holds the same text the old seller message had. Copy works.
5. Tick checklist rows. The count updates. Reloading the page clears the ticks, because saving them comes with offline saving.
6. Open a report with no seller questions or inspection tasks. Those two cards are missing.
7. Open a report that is still running. The cover says "Checking the listing", there are no message or checklist cards, and the page's self-refresh does not jump back to the cover.
8. Switch the interface to Estonian on an English report, and the other way round. Report text keeps its own language.

### Scope

The card row with cover, finding, message and checklist cards. Finding selection and seller message text move into tested modules first. Checklist ticks are not saved. Tasks are in [redesign plan checkpoint 3](plans/2026-10-10-redesign.md#checkpoint-3-report-cards).

## Checkpoint 4: Full report and evidence row

### What you will see

Under the cards there is a slim row with "Seller replied or new photos?" and the taustakontroll PDF upload. Below it sits a closed "Full report" section. Opening it shows:

- every finding, grouped by area, with its next check and evidence;
- other and cleared observations;
- the per-photo review status;
- the listing facts, the sources and the methodology note.

All of it is in the new style. The message card's "Seller replied" button opens the same add-evidence dialog. The old layout below the cards is gone.

### How to check

1. Open a complete report. Below the cards, the add-evidence row is visible and "Full report" is closed.
2. Open "Full report". Each area shows its counts. Open an area: its findings show the explanation, "Next check" and the evidence dialog.
3. Compare with the same report on `main`. Every finding from the old "All checks" appears.
4. Press "Seller replied" on the message card, then the button in the row. Both open the dialog with the supplement form. Submit a seller answer. A new run starts at the same address, and the cover shows the checking state.
5. Upload a taustakontroll PDF from the row. Then try a locked or oversized PDF. The upload is rejected with the existing error.
6. Open a report whose review is incomplete and idle. The retry button sits in the row.
7. With `LIVE_DIAGNOSTICS_ENABLED=true`, the Live diagnostics button sits in the row and opens the drawer.
8. Repeat in dark mode and in Estonian.

### Scope

The closed full report section, built so it can later move to its own page, the add-evidence row, the seller reply dialog, and removal of the old report layout. Retry is hidden offline from here on. Tasks are in [redesign plan checkpoint 4](plans/2026-10-10-redesign.md#checkpoint-4-full-report-and-the-evidence-row).

## Checkpoint 5: Report progress screen

### What you will see

While a report is being written, the top of the report shows the car's name, a three-part progress bar (Read listing, Review photos, Write review) with the same status lines as today, and the listing photos in a grid:

- waiting photos are grey placeholders;
- the photo under review shimmers;
- reviewed photos appear in full;
- unavailable photos say so.

Finding cards appear below as soon as there are findings. When the review finishes, the progress screen folds into one "Review complete" line.

### How to check

1. Submit a listing with photos, start the report and watch the top of the page.
2. The steps advance, and the "x of y reviewed" count matches the grid.
3. Stop the worker during the review. After the lease expires, the stale or stopped message shows in the attention color. Restart the worker, and the review continues.
4. Turn on reduce motion. There is no shimmer and no fold animation.
5. Open a report whose listing has no photos. It says "No supplied photos" and shows no grid.
6. Open a finished report. Only the "Review complete" line sits above the cards.
7. Read `DESIGN.md`. It describes the new system.

### Scope

The progress screen that replaces the activity journal, removal of old styles, and a rewritten `DESIGN.md`. Tasks are in [redesign plan checkpoint 5](plans/2026-10-10-redesign.md#checkpoint-5-report-progress-screen-and-design-record).

## Checkpoint 6: Phone layouts

### Before starting

Run a design round for phone widths on the pages from checkpoints 2 to 5, the same way the desktop demos were made, and get your approval. Record the result in the [redesign spec](specs/2026-10-10-redesign-design.md) and add tasks to the redesign plan.

### What you will see

On a phone, the start page, the listing page and the report use layouts made for a narrow screen. The report cards move with a one-finger swipe, and the controls you need at a viewing stay within thumb reach.

### How to check

1. Open each page in DevTools device mode at 390px, then on a real iPhone and a real Android phone.
2. Swipe through the report cards with one finger. Back and Next stay on screen.
3. Tick the checklist card with one hand while holding the phone.
4. Copy the seller message and paste it into the Auto24 app.
5. Repeat in dark mode and in Estonian.

### Scope

Phone layouts for the redesigned pages. No change to behavior or data.

## Checkpoint 7: Auto24 capture timings

### What you will see

Submit an Auto24 link and open Live diagnostics on the listing page right away, before the report exists. Capture phases appear as they finish: queue wait, browser start, page load, HTML retrieval and validation, parsing, browser shutdown, and saving the result. The finished report's drawer shows the same capture timings above the photo timings from the [photo timing checkpoint](archive/photo-preparation-timings/checkpoint.md).

### How to check

1. Rebuild and restart the extraction service containers, then start the app and the worker.
2. Submit a listing and open the drawer on the listing page.
3. Watch the phases appear, then open the report and find the same capture timings.
4. Check a capture with a failed and retried phase, and a capture where timing storage is unavailable. The drawer shows what it could not measure, and the capture still completes.
5. Open a listing captured before this checkpoint. It still works and shows "Not recorded".
6. Repeat the overhead comparison from the photo timing checkpoint, with its limit of 500 ms added time per pair.

### Scope

Additive Turso timing storage in the extraction service, Auto24 phase instrumentation, the listing diagnostics endpoint, the drawer on the listing page, and the link from a capture to its report.

## Checkpoint 8: Save a report on this device

### Before starting

Write the offline spec. It must:

- Choose the [access rule](#access-rule).
- Decide how a buyer finds a saved report without a connection: browser history, a bookmark, or a list of saved reports inside the worker scope.
- Choose between a hand-written service worker and Serwist. The [Next.js PWA guide](#offline-saving-background) suggests Serwist, which adds a dependency.

### What you will see

A report page has a button to save the report on this device. After saving, the page shows the save date and buttons to update or remove the saved copy. When the server has a newer version than the saved copy, the page says so. Nothing works offline yet. That comes in checkpoint 9.

### How to check

1. Open a report and save it. The save date appears.
2. Save a second report, remove the first, and check that the second still shows as saved.
3. Add a seller answer to a saved report. The page says a newer version exists, and the update button replaces the saved copy.
4. With a short expiry set for development, check that an expired copy is removed.
5. Check the chosen access rule. For example, clear the site's cookies, open the report again, and confirm the saved copy behaves as the rule says.
6. Repeat the checks in Estonian.

### Scope

An IndexedDB store with one record per `publicId`, a schema version, an expiry date, and room for viewing checklist marks so the checklist can come later without a data migration. The save, update and remove buttons, the save date, the newer-version notice, the chosen access rule, and ET/EN strings. Saving, updating, removing or deleting one report never touches another. Automated tests cover a removal while a fetch for that report is still running. No service worker yet.

## Checkpoint 9: Open a saved report offline

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

## Checkpoint 10: PDF processing and reassessment

### What you will see

Upload a taustakontroll PDF on a finished report and open Live diagnostics. The drawer shows how long validation, text extraction and upload took, then the new final assessment. It shows the previous and current final results, and marks text and photo results that were reused from the earlier run.

### How to check

1. Upload a PDF on a finished report and open the drawer.
2. Check that exactly one new final assessment runs, and that reused results keep their original times.
3. Upload a file the app rejects. No new run appears.
4. Repeat the overhead comparison from the photo timing checkpoint, with its limit of 500 ms added time per pair.

### Scope

PDF processing timings tied to accepted uploads, the PDF update and reuse view, and the previous and current final results. Results are compared as written. The drawer does not classify changes as added, changed or removed.

## Checkpoint 11: Earlier runs and timing export

Approve this checkpoint only if the photo timings and checkpoint 7 show that developers need run history or an export.

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
| Offline photos | Checkpoint 9 | Access-checked caching, because the image API returns `private, no-store`. A size limit per report. | This file |
| Offline taustakontroll PDFs | Offline photos | The same access-checked caching, with more storage | This file |
| Persistent viewing checklist | Checkpoint 8 record format | Ticks show on the checklist card from checkpoint 3 | [checkpoint 4 release](archive/report-checkpoints/checkpoint-4-release.md), [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Grouped findings | Nothing | Must keep every per-pass observation that the checkpoint 2 contract preserves | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| Transpordiamet summary | Nothing | Authorized access to the source. Ordinary service code, with no extra AI summarizer. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Factory manual excerpts | Nothing | Its own scoping for retrieval. Keep the manual version, vehicle match, and page references. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Paid VIN lookup | Late in development | A paid provider account and an explicit purchase flow. The reviewer cannot start purchases. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
