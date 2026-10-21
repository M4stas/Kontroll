# Redesign checkpoint 5: Review step and design record

This is the step plan for Codex agents. It is roadmap checkpoint 5 and redesign plan checkpoint 5. The redesign plan's Task 5.1 still describes the old folding progress screen and says to rewrite it from the spec, so this file replaces Task 5.1. Tasks 5.2 and 5.3 still apply, with the additions below. Where this file and the [redesign plan](2026-10-10-redesign.md#checkpoint-5-review-step-and-design-record) differ, this file wins.

- Spec: [redesign design](../../../specs/2026-10-10-redesign-design.md). Read decision 9 and the "Report" section: the review view (items 1 to 5) and item 1 of the report view.
- Approved demo: `demos/redesign/final/review.html`. Serve it with `python3 -m http.server 4317 --directory demos/redesign/final`. Its bar and grid styles are `.progress`, `.progress-labels` and `.grid-photos` in `style.css`. The "Replay" button is a demo control and does not ship.
- Checkpoints 1 to 4 must be merged into `redesign` before this starts: PR #23, PR #24, PR #26 with fix PR #27, and PR #29.
- Agents: follow the [development agent policy](../../../../agent-policy.md). Each step names its role from that policy. One writer at a time.

## What you will see

While a report is being written, its address shows the review view instead of the step journal:

- the car's name and the listing address;
- three bars with labels (Read listing, Review photos, Write review) that fill as the real review progresses, with an "x of y" photo count;
- the listing photos in a grid, where waiting photos shimmer, reviewed photos appear in full, and unavailable or unselected photos say so;
- an "Open the report" button with one status line beside it, plus Retry and Live diagnostics when they apply.

The button stays off until the review ends. Pressing it shows a "Review complete" line with the photo count, then the cards, the evidence row and the closed Full report. A report that has already finished when you open it goes straight to the cards. The old step journal and its fold animation are gone.

## How to check

1. Submit an Auto24 listing with photos and start the report. Keep the tab in front, because the report refresh pauses in a hidden tab.
2. Watch the bars. Read listing fills first. Review photos fills as photos finish, and its "x of y" count matches the number of reviewed tiles in the grid. Write review fills last.
3. Waiting tiles shimmer. Reviewed photos appear in full. An unavailable photo and a photo the review did not select each show a short label instead.
4. "Open the report" stays off during the review. When the review ends, it turns on and the status line says so. Press it: the "Review complete" line, the cards, the evidence row and the Full report appear. Reload the page: it opens straight to the cards.
5. Stop the worker during a review. After the lease expires, the status line shows the stale message in the attention color and "Open the report" turns on. Press it: the cards show the partial findings under the stale message. Restart the worker. The run continues, the page stays on the cards, and the report updates as the review finishes.
6. From the report view, send a seller answer. The page goes back to the review view for the new run. Photos reviewed in the earlier run show in full. When the run ends, "Open the report" turns on again.
7. Open a report whose listing had no photos. It says "No supplied photos" and shows no grid.
8. Open a report whose review is incomplete and idle. Retry sits beside the status line, and "Open the report" is on. With `LIVE_DIAGNOSTICS_ENABLED=true`, the Live diagnostics button sits beside the status line and opens the drawer.
9. Turn on reduce motion in the system settings. There is no shimmer, no bar animation and no button animation.
10. Repeat in dark mode and with the Estonian interface. At 390px wide nothing scrolls sideways and the grid has two columns.
11. Read `DESIGN.md`. It describes the new tokens, type, card row, evidence row, Full report and review view, and none of the old navy palette.

## Decisions since the redesign plan

1. **When "Open the report" turns on.** `activityState().complete` is true only when every selected photo is reviewed, none is unavailable and the final pass is done. A finished run with one unavailable photo, a failed run or a disabled review never reaches it, so a buyer would be stuck on the review view. The button turns on when nothing is visibly running: `progress.state` is `complete`, `stopped` or `stale`. It stays off while the state is `queued` or `running`, and while the page is still checking live progress before its clock starts. Stale is included because a crashed worker may never come back, and the stale copy already says the partial findings are saved. Put this rule in one exported function, `canOpenReport(progress)`, in `activity-steps.ts`.
2. **Which view shows first.** `ReportView` owns an `opened` state. It starts true when `offline` is set, or when `canOpenReport` is true on the first render and `report.activity?.state` is not `queued` or `running`, so a finished report opens straight to the cards. The second condition matters because the first render has no clock yet, and a running report would otherwise look stale and skip the review view. "Open the report" sets it to true. `router.refresh()` keeps the state because `ReportView` keeps its key.
3. **A new run after a seller answer or a PDF.** When the report's activity changes from `stopped` or no activity to `queued` or `running` after the buyer opened the report, `opened` goes back to false and the review view shows the new run. A worker that resumes a stale run is the same run, so the page stays on the cards. Derive this during render by comparing with the previous activity state, as `ActivityJournal` does with `seenComplete`. Do not use an effect.
4. **Retry and diagnostics.** In the review view, `RetryReview` (same condition and same `key` as in `EvidenceRow`) and the unchanged `DiagnosticsPanel` element sit beside the status line. In the report view they stay in `EvidenceRow`. Only one view renders at a time, so only one `DiagnosticsPanel` mounts. Do not change the diagnostics markup.
5. **The line above the cards.** After a complete review it reads "Review complete · {count} photos reviewed", with a new string `Report.activity.completeWithPhotos` in both languages. After a stopped or stale run it shows the existing stopped or stale copy in the attention color. Nothing folds or animates.
6. **Title and listing address.** Move the make and model logic out of `CoverCard` into a shared `vehicleTitle(report)` in `src/features/report/vehicle-title.ts`, and use it in both places. The listing address comes from the listing source's `url` in `report.sources`, when the report has one. Check the key name in `src/server/repositories/analyses.ts`. Show it as plain text, as the demo does. Leave the line out when there is no address.
7. **Photo tiles.** `pending` and `running` tiles shimmer. `complete` tiles show the photo through `EvidenceImage`, cropped to fill. `unavailable` and `skipped` tiles show `Report.review.imageStatus.*` on `--surface-2`, and `unavailable` uses the attention color. Load photos only for `complete` tiles. Each tile's label is `Report.review.photoNumber`, and the grid's label is `Report.review.photoStatuses`.
8. **Bars.** Read listing follows `review.text`, Review photos fills by `images.complete / images.selected`, and Write review follows `review.final`, as the spec says. An active step with no measurable fraction shows half fill. A step in the `warning` state colors its label with `--attention`. Fill with a `--f` custom property and `scaleX`, as the demo does.
9. **Old color aliases.** The old Tailwind colors (`text-steel`, `text-pale-blue`, `text-amber`, `steel/*`, `blue-gray`, `off-white`, `ink-navy`) are still used about 40 times in `evidence-disclosure.tsx`, `supplement-form.tsx`, `taustakontroll-form.tsx`, `retry-review.tsx`, `diagnostics-panel.tsx` and `review-card.tsx`. Replace them with the new tokens in all six files, then delete the aliases in `tokens.css` and the old entries in `@theme`. In the two diagnostics files, change class names only, with no element, text or behavior changes.
10. **Unused strings.** Checkpoint 4 left `Report.compact.allChecks` and `Report.evidence.noEvidence` unused, and removing `ActivityJournal` may leave more `Report.activity` keys unused. Check each key with `rg` and remove the unused ones from both message files.

## Rules for every step

- Work in a worktree at `.worktrees/redesign-5` on branch `codex/redesign-review-step`. It starts from `redesign` with this plan as its only commit. The PR targets `redesign`. Do not push to `main` or `redesign`.
- Start only after the user approves checkpoint 5.
- Run tests from a worktree under `.worktrees/`. From a worktree nested deeper, such as `.claude/worktrees/`, the symlinked `node_modules` loads React twice and about 170 unrelated tests fail with `Cannot read properties of null (reading 'useContext')`.
- Keep every finding visible: on a card or in the Full report.
- Report-authored text keeps `lang={report.locale}`. Interface strings go in `messages/en.json` and `messages/et.json`, in both languages, in the same commit.
- The `offline` prop always shows the report view. The review view, refresh, retry, diagnostics, the evidence row, the dialog and every upload form stay hidden offline.
- Keep `activity-state.ts` as the source of the progress state. Move logic out of `ActivityJournal` without changing what it computes.
- Add no dependencies. Icons come from `@phosphor-icons/react`. Read `node_modules/next/dist/docs/` before using a Next.js API you have not used in this project.
- Design and check at 1280 to 1600px. At 390px nothing may scroll sideways. Phone layouts come in roadmap checkpoint 6.
- Interactive elements are at least 44px tall with a visible focus ring. Shimmer, bar fill and button animations stop under `prefers-reduced-motion`.
- Use the internal browser for every browser test it supports. Use Brave only when the internal browser cannot do the test, such as light-mode emulation. Never use Firefox.
- Write code comments and docs in plain English with no em dashes. UI copy uses no em dashes.
- Commit after each step with the message given. If a step's check fails and you cannot fix it within the step, stop and report what failed.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `git fetch origin`. Check that PR #29 is merged into `origin/redesign`. If it is not, stop and tell the user.
2. `git worktree add .worktrees/redesign-5 codex/redesign-review-step`. Check that `git log --oneline origin/redesign..HEAD` lists only `docs:` commits. If `redesign` has moved on, merge `origin/redesign` first.
3. Symlink `node_modules` to the main checkout's and copy `.env.local`, as in `.worktrees/redesign-4`.
4. Run `npm test -- --maxWorkers=2` and write down the count. It must pass before any change. A single timeout in `tests/unit/worker/cli.test.ts` under full-suite load is known; rerun that file alone.
5. Write down `git rev-parse HEAD` as BASE.

## Step 1: Step logic

Role: small implementation changes and focused tests. Decisions 1 and 8.

1. Create `tests/unit/report/activity-steps.test.ts`. Port the state cases from `tests/unit/activity-journal.test.tsx` by name, as checks on `activitySteps` instead of the rendered journal:
   - `does not mark a pending empty inventory as reviewed`
   - `keeps the photo step running while an incomplete review has a live worker lease`
   - `shows an incomplete queued retry as queued when worker activity is queued`
   - `keeps saved photo progress visible while a PDF final assessment is queued`
   - `shows partially saved photos while a PDF update waits for remaining reviews`
   - `writes the final review after all selected photos complete despite policy skips`

   Add:
   - `marks read listing done and photos active while photos are reviewed`
   - `marks a step warning when progress is stale or stopped`
   - `fills the photo bar by complete over selected photos`
   - `opens the report when the run is complete, stopped or stale, not while queued, running or checking live progress`
2. Run `npx vitest run tests/unit/report/activity-steps.test.ts` and see the new tests fail.
3. Create `src/features/report/activity-steps.ts` with:
   - `activitySteps(report, progress)`, returning one entry per step: `key` (`readListing`, `reviewPhotos` or `writeReview`), `state` (`waiting`, `active`, `done` or `warning`), `fill` from 0 to 1, `detailKey` and optional `detailValues`. Move the `done`, `current` and `details` logic out of `ActivityJournal` without changing its results.
   - `canOpenReport(progress)` from decision 1.
4. Run the new file, then the suite. Both pass.
5. Commit: `feat: derive review steps and when the report can open`.

## Step 2: Review view

Role: integration. Decisions 2 to 7.

1. Rename `tests/unit/activity-journal.test.tsx` to `tests/unit/report/report-progress.test.tsx`. Drop the fold tests (`folds a newly completed review after 2.1 seconds`, `reduces completion motion to an immediate compact state`, `keeps the completion timer through fresh report objects`, `collapses a completed review when all selected photos and final writing are complete`). Keep the clock tests:
   - `removes the spinner when a confirmed worker lease expires`
   - `shows a neutral live-progress message before the client clock is initialized`
   - `shows an expired lease warning once the client clock is initialized`

   Add:
   - `shows one tile per supplied photo with its review state`
   - `loads photos only for reviewed tiles`
   - `hides the grid and says so when no photos were supplied`
   - `keeps Open the report off until the run is over`
   - `shows retry and diagnostics beside the status line when they apply`

   In `tests/unit/report/report-view.test.tsx` add:
   - `opens a finished report straight to the cards`
   - `shows the review view for a running report and the cards after Open the report`
   - `returns to the review view when a new run starts`
   - `stays on the cards when a stale run resumes`
   - `starts a running report on the review view before the clock starts`
   - `always shows the report view offline`
   - `shows the photo count above the cards after a complete review`
2. See them fail.
3. Implement:
   - `src/features/report/vehicle-title.ts` from decision 6, used by `CoverCard` and the review view.
   - `src/features/report/report-progress.tsx`: `ReportProgress({ report, diagnosticsEnabled, onOpen })`. It keeps the journal's clock, online and reduced-motion handling, and renders the title, the address, the bars with labels and details, the grid, the button, the status line in a live region, and retry and diagnostics.
   - `src/app/[locale]/styles/report-progress.css`, imported next to `full-report.css`. Copy the bar and grid rules from the demo's `style.css` and use only tokens. Stale and stopped use `--attention`.
   - `ReportView`: the `opened` state from decisions 2 and 3. Before opening it renders `ReportProgress` only. After opening it renders the line from decision 5, `ReportDeck`, `EvidenceRow`, `FullReport` and `SupplementDialog`.
   - Delete `src/features/report/activity-journal.tsx` and its `.activity-*` and `.journal-*` rules in `globals.css`. Check with `rg "activity-journal|journal-dot|activity-step|activity-fold" src tests` that nothing still uses them.
4. Run the new tests and the suite. Both pass.
5. Commit: `feat: show the review step before the report cards`.

## Step 3: Remove leftovers

Role: small implementation changes and focused tests. Redesign plan Task 5.2 steps 1 and 2, plus decisions 9 and 10.

1. Replace the old color classes from decision 9, then delete the aliases in `tokens.css` and the old `@theme` entries in `globals.css`.
2. For every class left in `globals.css`, search `src/` for it and delete rules nothing uses.
3. Remove the unused strings from decision 10.
4. `git diff BASE -- src/features/diagnostics` shows only class name changes.
5. Run `npm test -- --maxWorkers=2` and `npm run build`. Both pass.
6. Commit: `refactor: remove old color aliases and unused styles`.

## Step 4: Design record

Role: not in the allocation table, so it inherits the current chat's model. Redesign plan Task 5.2 steps 3 and 4.

1. Rewrite `DESIGN.md` from the built app with the Impeccable `document` flow. It records the tokens, type, components, the card row, the evidence row, the Full report and the review view as built.
2. Regenerate `.impeccable/design.json`.
3. Commit: `docs: record the redesign in DESIGN.md`.

## Step 5: Run the gates

Role: small implementation changes and focused tests.

`npm run lint`, `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build` and `git diff --check`. All pass. The lint warning in `demos/redesign/final/walk.js` is known.

## Step 6: Check it in the browser and save evidence

Role: manual frontend E2E and demo testing.

1. `npm run build`, then `npm run start -- -p 3000` and `npm run worker`. If port 3000 is taken, use a free port and do not stop the server that holds it. Restart `npm run start` after every rebuild.
2. Run every "How to check" step against real reports and the real worker, including a worker stop and restart and a real seller answer. Synthetic fixture routes are allowed only for states that cannot be reached otherwise, such as a report with no photos or an incomplete idle review. Remove any such route before Step 7 and say so in the evidence.
3. Save screenshots at 1440x900 to `docs/superpowers/checkpoints/redesign-5/`: the review view mid-run, the stale state with the button on, the finished review with the button on, and the report view's top line with the cards. Each in light and dark, ET and EN. Add one 390px capture of the review view.

## Step 7: Finish review

Role: not in the allocation table, so it inherits the current chat's model. Redesign plan Task 5.3 step 3.

Run the Impeccable finish review against the spec, `demos/redesign/final/review.html` and the Step 6 screenshots. Fix its material findings, rerun the gates and replace any screenshots that changed.

## Step 8: Independent review

Role: independent code review. Review the whole branch against this file, the redesign plan and the spec. Check in particular:

- no report state leaves the buyer on the review view with the button off once nothing is visibly running;
- offline always shows the report view and hides every control listed in the rules;
- the diagnostics diff contains only class name changes;
- every finding stays visible.

Fix material findings and rerun the gates.

## Step 9: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/<date>-redesign-5.md` with the gate results, the test counts against BASE and the screenshot list, as in the checkpoint 4 evidence file.
2. In `docs/superpowers/roadmap.md`, set row 5 to "PR #N; user acceptance pending" and point its Source column at this file.
3. Open the PR against `redesign` with `/pr`. Stop and wait for the user's check.

## After the user accepts checkpoint 5

The roadmap says one PR then merges `redesign` into `main`. That PR is not part of this checkpoint and needs its own approval.
