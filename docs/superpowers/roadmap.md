# Roadmap

Planned work that is not yet implemented. Finished work lives in [archive](archive/README.md), including the [photo preparation timings](archive/photo-preparation-timings/checkpoint.md) from PR #22, the [redesign](archive/redesign/), checkpoints 1 to 6, from PRs #23 to #33, the [Auto24 capture timings](archive/auto24-capture-timings/checkpoint.md), checkpoint 7, from PR #46, and [offline reports](archive/offline-reports/), checkpoints 8 and 9, from PRs #37 and #40.

Each checkpoint ends with a change you can see in the running app. After a checkpoint, run the app, follow its check steps, and then decide whether to approve the next one. Checkpoint numbers here follow roadmap order, in one sequence. Checkpoints 1 to 6 (the redesign), 7 (Auto24 capture timings) and 8 and 9 (offline reports) are archived. Names in brackets are the earlier names: A1 to A3 came from the registration reveal spec and S3 B from the service roadmap. Plans and specs keep their own numbering, and the Source column maps them. Checkpoint 10's steps are in its plan; 11 to 13 get sections here when they are planned.

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| 10 | Reg number and VIN on the listing page (was S3 B) | The listing appears as soon as its job completes; the reg number and VIN rows pulse, then show the values or "Not found", and the report button waits for them | Merged in #52, with S3 A merged in #54. Archive it after your live check of the listing page | [Identity plan checkpoint B](plans/2026-10-21-chromium-identity-integration.md#checkpoint-b-reg-number-and-vin-on-the-listing-page) |
| 11 | "Auto24" as the source of the reg number and VIN in the report (was A1) | The report names Auto24 as the source of the full registration number and VIN | Not planned. Checkpoint 10 already adds the values to the report facts | [Registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md#main-roadmap) |
| 12 | Solve record in Live diagnostics (was A2) | Each reveal attempt, its rounds, labels, picks and failure reasons in the drawer on the listing page | Ready to plan | [Registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md#main-roadmap) |
| 13 | Registration number from a photo (was A3) | "Read from photo", or "unavailable" with a reason, when the reveal fails | Ready to plan | [Registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md#main-roadmap) |
| 14 | PDF processing and reassessment (was 10) | PDF processing times and the previous and current final results after a taustakontroll upload | Plan rewritten on 2026-10-21; not approved | [PDF diagnostics plan](plans/2026-10-21-pdf-diagnostics.md) |
| 15 | Model review tool, one setup (was 12) | A dev-only page that runs one real listing through a chosen image model and review model | Spec written; not approved | [Model review tool spec](specs/2026-10-20-model-review-tool-design.md) |
| 16 | Model review tool, three setups (was 13) | Up to three setups side by side, with photo-pass and text-pass details | Spec written; not approved | [Model review tool spec](specs/2026-10-20-model-review-tool-design.md) |
| 17 | Model review tool, scoring and past runs (was 14) | 1–5 scores in each column, past runs, and score averages | Spec written; not approved | [Model review tool spec](specs/2026-10-20-model-review-tool-design.md) |

Extraction service work is in the [service roadmap](service-roadmap.md). Checkpoint 10 is the website half of service checkpoint S3 (its checkpoint B).

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

After checkpoints 15 to 17, do steps 1 and 2 in the model review tool with real listings instead.

## Checkpoint 14: PDF processing and reassessment

### What you will see

Upload a taustakontroll PDF on a finished report and open Live diagnostics. The drawer shows how long validation, text extraction and upload took, then the new final assessment. It shows the previous and current final results, and marks text and photo results that were reused from the earlier run.

### How to check

1. Upload a PDF on a finished report and open the drawer.
2. Check that exactly one new final assessment runs, and that reused results keep their original times.
3. Upload a file the app rejects. No new run appears.
4. Repeat the overhead comparison from the photo timing checkpoint, with its limit of 500 ms added time per pair.

### Scope

PDF processing timings tied to accepted uploads, the PDF update and reuse view, and the previous and current final results. Results are compared as written. The drawer does not classify changes as added, changed or removed.

Tasks and the full check steps are in the [PDF diagnostics plan](plans/2026-10-21-pdf-diagnostics.md).

## Checkpoint 15: Model review tool, one setup

A dev-only page that runs one real listing through chosen models. The [model review tool spec](specs/2026-10-20-model-review-tool-design.md) has the design.

### Before starting

- Write the implementation plan from the spec.
- Add `MODEL_REVIEW_ENABLED=false` to `.env.example` and `.model-review/` to `.gitignore`.

### What you will see

With `MODEL_REVIEW_ENABLED=true` in `.env.local`, `/en/dev/model-review` shows a listing input. Paste an Auto24 URL or a report link, pick one image model and one review model, and run. One column fills with the final findings, then the summary.

### How to check

1. Set `MODEL_REVIEW_ENABLED=true`, restart `pnpm dev` and `pnpm worker`, and open `/en/dev/model-review`.
2. Paste an Auto24 link. The page waits while the worker fetches it, then shows the car title and first photo.
3. Pick an image model and a review model, then press Run. One column fills with findings that cite photos and listing fields.
4. Open the normal report for that listing. Its findings did not change.
5. Paste a report link instead of an Auto24 link. The page skips the fetch.
6. Set `MODEL_REVIEW_ENABLED=false` and reload. The page returns 404.

### Scope

The dev-only gate, fetching through the normal flow, one setup, the shared runner taken out of the review coordinator, and the run file.

## Checkpoint 16: Model review tool, three setups

### What you will see

Up to three setup cards, each with its own image and review model, and a call count on the Run button. Results show in side-by-side columns with collapsed photo-pass and text-pass sections.

### How to check

1. Add three setups. Give one an image model other than `gpt-6-luna`.
2. Pick a model that is not declared in `DATA_REVIEW_CAPABILITIES` by editing `.env.local`, then reload. The card shows `unknown_model` and Run is disabled.
3. Run three valid setups. The call count matches the number of passes that run, and all three columns fill.
4. Open the photo-pass section in one column. Each photo shows its findings or its error.
5. Stop `pnpm dev` during a run and start it again. Unfinished passes show as interrupted. "Retry failed passes" finishes them.
6. Shrink the window to phone width. Columns stack with tabs to switch setups.

### Scope

Up to three setups, capability-filtered dropdowns, parallel runs, photo and text pass sections, and retries.

## Checkpoint 17: Model review tool, scoring and past runs

### What you will see

Four 1–5 score rows and a notes field under each column, a "Past runs" list, a field for which setup you would choose, and a score averages table across saved runs.

### How to check

1. Score each column and reload the page. The scores are still there.
2. Open an earlier run from "Past runs". Its columns and scores load.
3. Fill in which setup you would choose and why, then reload. The text is still there.
4. Score two runs that share a model pair. The averages table shows one row for that pair with two scored runs and the mean of each question.

### Scope

Scoring, the past runs list, the choice field, and the score averages table.

## Deferred backlog

These items are not scheduled. When one is scheduled, give it a checkpoint with a visible result and check steps like the ones above. The table lists what each item depends on and what it needs beyond your approval.

| Item | Depends on | Also needs | Source |
| --- | --- | --- | --- |
| Earlier runs and timing export (was checkpoint 11) | The photo timings and [checkpoint 7](archive/auto24-capture-timings/checkpoint.md) showing that developers need run history or an export | A decision on whether the export holds every paginated record or lists the ones it left out. A run picker with pagination and a timing-only JSON file (no findings, document text, photos, URLs or secrets). | [Diagnostics plan checkpoint 3](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| Offline photos | [Offline reports](archive/offline-reports/) | Access-checked caching, because the image API returns `private, no-store`. A size limit per report. | This file |
| Offline taustakontroll PDFs | Offline photos | The same access-checked caching, with more storage | This file |
| Persistent viewing checklist | The saved-report record format from [offline reports](archive/offline-reports/) | Ticks show on the report's checklist card | [checkpoint 4 release](archive/report-checkpoints/checkpoint-4-release.md), [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Grouped findings | Nothing | Must keep every per-pass observation that the checkpoint 2 contract preserves | [checkpoint 2 analysis](archive/report-checkpoints/checkpoint-2-analysis.md) |
| Transpordiamet summary | Nothing | Authorized access to the source. Ordinary service code, with no extra AI summarizer. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Factory manual excerpts | Nothing | Its own scoping for retrieval. Keep the manual version, vehicle match, and page references. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
| Paid VIN lookup | Late in development | A paid provider account and an explicit purchase flow. The reviewer cannot start purchases. | [reviewer plan](archive/report-checkpoints/2026-09-30-used-car-data-reviewer-plan.md) |
