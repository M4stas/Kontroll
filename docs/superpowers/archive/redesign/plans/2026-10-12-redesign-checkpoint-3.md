# Redesign checkpoint 3: Report cards

This is the step plan for Codex agents. It is roadmap checkpoint 3 and redesign plan checkpoint 3. The task details live in [redesign plan checkpoint 3](2026-10-10-redesign.md#checkpoint-3-report-cards), Tasks 3.1 to 3.5. This file adds the order, the rules and the decisions made since that plan was written.

- Spec: [redesign design](../../../specs/2026-10-10-redesign-design.md). Read decisions 1, 2, 6 and 9, and the "Report" section.
- Approved demo: `demos/redesign/final/`. Serve it with `python3 -m http.server 4317 --directory demos/redesign/final` and open `report.html`. The demo's mileage meter and the "ask" box on finding cards do not ship (spec decision 1 and the note under "Report").
- Checkpoints 1 and 2 are merged into `redesign` (PR #23 and PR #24). Use the tokens in `src/app/[locale]/styles/tokens.css`. Add no new colors.
- Agents: follow the [development agent policy](../../../../agent-policy.md). Each step names its role from that policy. One writer at a time.

## What you will see

A report opens with the existing progress journal, then a row of large cards. Move through them with Back and Next, the arrow keys, the progress strip or a trackpad swipe:

- A cover with the verdict, the car's first photo and how many things to check.
- One card per main finding: its photo or an area icon on the left, and what was found and where it came from on the right.
- A "Send it in one message" card with the seller message and a copy button.
- An "At the viewing" card where you tick off checks.

The other sections (all checks, sources, photo states, upload forms) still sit below the cards until checkpoint 4. The journal keeps its current look until checkpoint 5, when it becomes the review step.

## How to check

1. Open a complete report with photos. The cover shows the vehicle line, the verdict, "N things to check before you go", the status and the confidence, over the first listing photo.
2. Press Next and Back. Click into the cards and use the arrow keys. Use the progress strip. The Next button names the next card.
3. Finding cards have no "next check" box. The source line opens the evidence dialog with the photo or the quoted text.
4. The message card holds the same text the old seller message had. Copy works.
5. Tick checklist rows. The count updates. Reloading clears the ticks, because saving them comes with offline saving.
6. Open a report with no seller questions or inspection tasks. Those two cards are missing.
7. Open a report that is still running. The cover says "Checking the listing", there are no message or checklist cards, and the page's refresh does not jump back to the cover.
8. Switch the interface to Estonian on an English report, and the other way round. Report text keeps its own language.
9. Repeat in light mode. At 390px wide, nothing scrolls sideways and every control is reachable.

## Decisions since the redesign plan

1. The verdict appears once. The cover card takes over the `written-report-header` block (vehicle line, verdict, status line, confidence note). Remove that header from `ReportView`. The Live diagnostics button stays where it is, above the journal.
2. In this checkpoint the cards show directly under the journal. The "Open the report" button from spec decision 9 belongs to checkpoint 5. Do not build it here.
3. `ReportDeck` must not depend on the journal or on page layout above it, so checkpoint 5 can put it behind the button without changes.

## Rules for every step

- Work in a worktree at `.worktrees/redesign-3` on branch `codex/redesign-report-cards`. It starts from `redesign` with this plan as its only commit. The PR targets `redesign`. Do not push to `main` or `redesign`.
- The user approved checkpoint 3 on 2026-10-12.
- Run tests from a worktree under `.worktrees/`. From a worktree nested deeper, such as `.claude/worktrees/`, the symlinked `node_modules` loads React twice and about 170 unrelated tests fail with `Cannot read properties of null (reading 'useContext')`.
- Keep every finding visible somewhere: on a card or in the sections below (spec "Product rules").
- Report-authored text keeps `lang={report.locale}`. Interface strings come from `messages/en.json` and `messages/et.json` under `Report.deck`, in both languages.
- The `offline` prop keeps hiding refresh, diagnostics and every upload form. The cards render offline.
- Add no dependencies. Icons come from `@phosphor-icons/react`, already installed. Read `node_modules/next/dist/docs/` before using a Next.js API you have not used in this project.
- Design and check at 1280 to 1600px. At 390px nothing may scroll sideways. Phone layouts come in roadmap checkpoint 6.
- Animations stop under `prefers-reduced-motion`.
- Write code comments and docs in plain English with no em dashes.
- Commit after each step with the message given in the redesign plan task. If a step's check fails and you cannot fix it within the step, stop and report what failed.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `git fetch origin` and `git worktree add .worktrees/redesign-3 codex/redesign-report-cards`. Check that `git log --oneline origin/redesign..HEAD` lists only `docs:` commits. If `redesign` has moved on, merge `origin/redesign` first.
2. Symlink `node_modules` to the main checkout's and copy `.env.local`, as in `.worktrees/redesign-2`.
3. Run `npm test` and write down the count. It must pass before any change. A single timeout in `tests/unit/worker/cli.test.ts` under full-suite load is known; rerun that file alone.
4. Write down `git rev-parse HEAD` as BASE.

## Step 1: Finding selection module

Role: small implementation changes and focused tests. Redesign plan Task 3.1. The selection block is `report-view.tsx` lines 107 to 139 today; the tests to port are `report-view.test.tsx` lines 92 to 162.

## Step 2: Seller message text module

Role: small implementation changes and focused tests. Redesign plan Task 3.2.

## Step 3: Card row component

Role: small implementation changes and focused tests. Redesign plan Task 3.3. Port the behavior from `demos/redesign/final/walk.js` and `walk.css`.

## Step 4: Report cards in the report

Role: integration. Redesign plan Task 3.4, plus decision 1 above: delete the `written-report-header` block from `ReportView` and move its content to `CoverCard`. Retarget the tests that read the header, such as `renders the verdict before unresolved findings`, at the cover card.

## Step 5: Run the gates

Role: small implementation changes and focused tests.

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `git diff --check`. All pass. The lint warning in `demos/redesign/final/walk.js` is known.

## Step 6: Check it in the browser and save evidence

Role: manual frontend E2E and demo testing.

1. `npm run build`, then `npm run start -- -p 3000` and `npm run worker`. Restart `npm run start` after every rebuild; it serves the build that existed when it started.
2. Keep the browser tab in front. The listing poller and the report refresh pause while a tab is hidden, including a hidden in-app browser pane, so a hidden tab looks stuck.
3. Run every "How to check" step. Use a complete report with photos, a running report, a report with no actions and an Estonian report. Use keyboard only, then a trackpad swipe.
4. Save screenshots of each card at 1440x900 in light and dark, ET and EN, to `docs/superpowers/checkpoints/redesign-3/`. Real listing photos show number plates; that matches checkpoint 2's evidence.

## Step 7: Independent review

Role: independent code review. Review the whole branch against this file, the redesign plan tasks and the spec. Fix material findings and rerun the gates.

## Step 8: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/2026-10-12-redesign-3.md` with the gate results, test counts against BASE and the screenshot list.
2. Set roadmap row 3 to "PR #N; user acceptance pending".
3. Open the PR against `redesign` with `/pr`. Stop and wait for the user's check. Finishing this checkpoint does not approve checkpoint 4.
