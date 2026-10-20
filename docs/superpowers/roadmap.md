# Roadmap

Planned work that is not yet implemented. Finished work lives in [archive](archive/README.md), including the [photo preparation timings](archive/photo-preparation-timings/checkpoint.md) from PR #22, the [redesign](archive/redesign/), checkpoints 1 to 6, from PRs #23 to #33, and [offline reports](archive/offline-reports/), checkpoints 8 and 9, from PRs #37 and #40.

Each checkpoint ends with a change you can see in the running app. After a checkpoint, run the app, follow its check steps, and then decide whether to approve the next one. Checkpoint numbers here follow roadmap order. Checkpoints 1 to 6 (the redesign) and 8 and 9 (offline reports) are archived. The live diagnostics plan uses its own checkpoint numbers, and the Source column maps them.

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| 7 | Auto24 capture timings | Capture phases on the listing page, before the report exists | Approved on 2026-10-13; back end built on an unpushed branch | [Capture timings plan](plans/2026-10-13-auto24-capture-timings.md) |
| 10 | PDF processing and reassessment | PDF processing times and the previous and current final results after a taustakontroll upload | Planned, not approved | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| 11 | Earlier runs and timing export | A run picker and a downloadable timing file | Only if the photo timings and checkpoint 7 show a need | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |

The [human model-quality review](#alongside-the-checkpoints-human-model-quality-review) is your task and can happen at any time. Unscheduled work is in the [deferred backlog](#deferred-backlog).

## How each checkpoint works

- Work on a checkpoint starts only after you approve it. Finishing one checkpoint does not approve the next.
- Each checkpoint gets its own PR against `main`. A checkpoint is done when its automated checks pass, an independent review is clean, and you have run the app and seen the result it describes.
- Run the app as described in [local development](../local-development.md).
- New pages follow the [redesign spec](specs/2026-10-10-redesign-design.md) and `DESIGN.md`, on desktop and at 390px.
- Diagnostics checkpoints need `LIVE_DIAGNOSTICS_ENABLED=true` in `.env.local`.
- Offline checkpoints need a production build, with `pnpm build` and then `pnpm start`. The Next.js offline guide says dev mode is not reliable for offline behavior.

## Alongside the checkpoints: human model-quality review

Only an AI has graded the reviewer models so far. The checkpoint 2 comparison of `gpt-6.1-sol` and `gpt-6-luna` used synthetic listings, and its photo case used a drawn wheel instead of a real car photo. The [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) lists human model-quality signoff as open.

1. Run a model comparison, then score it in the [model compare page](../../tools/model-compare/index.html). The page is a standalone HTML file outside the app. Open it in a browser, load the result JSON, and it shows the two answers for each case as A and B without saying which model wrote which. Pick 1 to 5 for the four questions in [human scoring](../reviewer-evaluation-guide.md#human-scoring), then download the scores file for `evaluate-reviewer.ts summarize`. Scores are kept in the browser until you download them, and a downloaded scores file can be loaded again to continue.
2. Read at least one real report from start to end, such as the October 3 Passat report in the checkpoint 2 analysis. The synthetic cases do not establish ground truth. Check whether the findings are true for that car, whether the report missed something obvious, and whether the seller questions are worth asking. Pick a report with real listing photos, because no test has checked damage recognition on real photos yet.
3. Record the scores, the notes, and the chosen reviewer model, and link them from this file.

## Checkpoint 7: Auto24 capture timings

Status on 2026-10-20: tasks 1 to 4 of the [capture timings plan](plans/2026-10-13-auto24-capture-timings.md), the back end, are built on `codex/auto24-capture-timings`. That branch is not pushed. The diagnostics panel, the overhead measurement and the PR are still to do, after a rebase onto `main`.

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

## Deferred backlog

These items are not scheduled. When one is scheduled, give it a checkpoint with a visible result and check steps like the ones above. The table lists what each item depends on and what it needs beyond your approval.

| Item | Depends on | Also needs | Source |
| --- | --- | --- | --- |
| Offline photos | [Offline reports](archive/offline-reports/) | Access-checked caching, because the image API returns `private, no-store`. A size limit per report. | This file |
| Offline taustakontroll PDFs | Offline photos | The same access-checked caching, with more storage | This file |
| Persistent viewing checklist | The saved-report record format from [offline reports](archive/offline-reports/) | Ticks show on the report's checklist card | [checkpoint 4 release](archive/report-checkpoints/checkpoint-4-release.md), [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Grouped findings | Nothing | Must keep every per-pass observation that the checkpoint 2 contract preserves | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| Transpordiamet summary | Nothing | Authorized access to the source. Ordinary service code, with no extra AI summarizer. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Factory manual excerpts | Nothing | Its own scoping for retrieval. Keep the manual version, vehicle match, and page references. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Paid VIN lookup | Late in development | A paid provider account and an explicit purchase flow. The reviewer cannot start purchases. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
