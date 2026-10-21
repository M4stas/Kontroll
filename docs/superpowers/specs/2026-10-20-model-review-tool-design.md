# Model review tool design

Covers [roadmap checkpoints 15 to 17](../roadmap.md#checkpoint-15-model-review-tool-one-setup). The user made the decisions below on 2026-10-20.

## Goal

The [human model-quality review](../roadmap.md#alongside-the-checkpoints-human-model-quality-review) needs real listings and real photos. Today `scripts/evaluate-reviewer.ts` runs only synthetic fixtures, compares only two models, and forces one model for every pass.

This tool takes one Auto24 listing, fetches its data and photos once, and runs the same input through up to three model setups. Each setup can use a different image model and a different review model. The developer reads the results side by side, scores them, and picks a reviewer model.

## Decisions

| Question | Decision |
| --- | --- |
| Where it runs | A dev-only page inside the Next.js app |
| Blind scoring | No. Model names show in each column header. |
| What a column shows | The reviewer output as findings, not a rendered report |
| Saving runs and scores | JSON files in a gitignored `.model-review/` folder |
| Picking models | Dropdowns built from `DATA_REVIEW_CAPABILITIES` |
| Image models | Any declared model with image input, not only the production `gpt-6-luna` |
| Fetching the listing | The normal submission flow and worker, or an existing report link |

## What exists today

- `scripts/evaluate-reviewer.ts` runs a baseline and a candidate model on synthetic fixtures in unified mode. It writes a result JSON and a `.human-review.md` sheet. `summarize` turns human scores into per-model means.
- `tools/model-compare/index.html` loads that result JSON and shows two answers as A and B for scoring.
- `src/config/review.ts` resolves split mode with separate text, image and final passes. The final pass uses the text pass settings. `resolveProductionReviewConfig` pins the image pass to `codex` / `gpt-6-luna` with an `xhigh` ceiling.
- `src/analysis/review-coordinator.ts` runs text, image and final passes for a pinned `ReviewRunSnapshot`.

The script and compare page stay as they are for the synthetic fixtures.

## Access

- Page: `/[locale]/dev/model-review`.
- API routes: `/api/dev/model-review/*`.
- Both return 404 unless `MODEL_REVIEW_ENABLED=true` and `NODE_ENV` is not `production`. This follows the `LIVE_DIAGNOSTICS_ENABLED` flag in `src/config/application.ts`.
- `.env.example` gets `MODEL_REVIEW_ENABLED=false` with a one-line comment.

## Flow

1. **Choose the listing.** The developer pastes an Auto24 URL or a report link (`/et/r/<publicId>` or `/en/r/<publicId>`).
   - An Auto24 URL goes through the normal submission flow. The running worker captures the listing, prepares photos, runs baseline checks and builds a normal private report with its own production review.
   - The page shows a waiting state until the analysis has a pinned review snapshot. The snapshot holds the listing input, the image manifest and the selected photos.
   - A report link skips the fetch and uses that report's latest snapshot.
2. **Configure setups.** The developer adds one to three setups. Each setup has:
   - an image model and image effort
   - a review model and review effort, used for the text and final passes

   One report language, ET or EN, applies to the whole run. Before starting, the page shows the call count, for example "3 setups × (1 text + 8 photos + 1 final) = 30 calls".
3. **Run.** For each setup the server resolves a split-mode config with `resolveReviewConfig`. It does not call `resolveProductionReviewConfig`. It then runs text, each selected photo and final, in the same order and with the same inputs the worker uses, against the stored snapshot. Photos go through the existing image capability path.
   - Setups run in parallel. Within a setup, photos use production concurrency.
   - Nothing is written to `review_executions` or to any table the report reads. The buyer's report never changes.
4. **Save.** The server writes progress and results to `.model-review/<runId>.json`. The page polls it.

### Shared runner

The tool must run the same passes the worker runs. Pull the pass order and input building out of `coordinateReviews` into a function that both the worker and the tool call. The worker keeps its repository writes. The tool supplies an in-memory sink that writes to the run file. This keeps prompts, inputs and merge rules identical, and it avoids copying the coordinator.

## Run file

`.model-review/` is added to `.gitignore`. A run file records:

- schema version, run ID, created time, language
- listing URL, analysis ID, public report ID
- snapshot input hash, so two runs can be checked for identical input
- per setup:
  - image provider, model and effort
  - review provider, model and effort
  - prompt hash
  - per pass: status (`pending`, `running`, `complete`, `failed`, `interrupted`), elapsed time, schema status, error code, and the returned result
  - the merged final findings, built with `mergedReviewObservations`
  - scores and notes
- the overall choice and its reason

Signed image capabilities, signed URLs and secrets are never written. The file is validated with zod on read. A file that fails validation shows as unreadable in the past runs list, and the page does not crash.

## Page layout

Uses the app tokens and Geist. No new design work.

### Top bar

- Listing input and the ET/EN switch for the run.
- A "Past runs" list that reads `.model-review/`, newest first, by car title and date.
- Once fetched, the car title and first photo.

### Setup cards

- Up to three cards. Each has image model, image effort, review model and review effort dropdowns.
- Dropdowns list only declared models that fit the pass. Image models must declare `imageInput`. Every model must declare `text` and `structuredOutput`, and OpenAI models must also declare `responses`. Effort lists show only that model's declared efforts.
- Duplicate and remove buttons on each card.
- When a card's config does not resolve, the card shows the code, such as `unknown_model` or `missing_credentials`. The Run button stays disabled until every card resolves.
- The Run button shows the call count.

### Result columns

One column per setup, with the model names and efforts in its header.

- **Summary:** total time, failed passes, findings by severity.
- **Final findings:** the merged list a buyer would see. Each finding shows its title, severity, explanation, recommended action and cited evidence. Cited photos show as thumbnails, and cited listing fields show as short chips.
- **Photo pass:** collapsed. One row per photo with its thumbnail, its findings or its error.
- **Text pass:** collapsed. The raw text-pass findings.
- **Scoring:** Support, Relevance, Vehicle judgment and Language from 1 to 5, as defined in [human scoring](../../reviewer-evaluation-guide.md#human-scoring), plus a notes field. Scores save to the run file as soon as they change.

At narrow widths the columns stack, with tabs to switch setups.

### Under the columns

- "Which setup would you choose, and why?" saved to the run file.
- A "Score averages" table across all saved runs. One row per model pair (image model and effort, review model and effort), with the number of scored runs and the mean for each of the four questions. `evaluate-reviewer.ts summarize` is not reused, because it only pairs one baseline with one candidate.

## Errors

| Case | Behaviour |
| --- | --- |
| Capture fails or the listing has no photos | The page shows the analysis error and links the report |
| A setup's config does not resolve | Shown on the card before the run. Run stays disabled. |
| A pass times out or returns invalid JSON | Recorded in that column. Other setups and passes keep going. |
| Some passes failed | "Retry failed passes" on that column reruns only those passes |
| The dev server restarts mid-run | On read, passes left `running` become `interrupted` and can be retried |
| `MODEL_REVIEW_ENABLED` off or production build | Page and API return 404 |

## Testing

Unit tests:

- A setup becomes a split-mode config, including an image model other than `gpt-6-luna`.
- Dropdown filtering by declared capabilities and efforts.
- Run file schema round trip, and interrupted passes after a restart.
- Score averages group runs by model pair and skip unscored setups.
- The gate returns 404 when the flag is off and in production.

Runner test with fake reviewers:

- Passes run in the worker's order with the same inputs.
- One failing setup does not stop the others.
- Nothing calls the `review_executions` repository.

The worker's existing review coordinator tests must still pass after the shared runner is extracted.

Browser checks run in the internal browser.

## Out of scope

- Blind A/B scoring. The existing compare page covers that for fixtures.
- Providers other than OpenAI and Codex.
- More than three setups in one run.
- Storing runs in Supabase or sharing them across machines.
- Changing which model production uses. The developer records the chosen model in the roadmap, and changing production is separate work.
