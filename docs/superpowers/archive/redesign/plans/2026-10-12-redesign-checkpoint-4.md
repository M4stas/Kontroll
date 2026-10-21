# Redesign checkpoint 4: Full report and the evidence row

This is the step plan for Codex agents. It is roadmap checkpoint 4 and redesign plan checkpoint 4. The task details live in [redesign plan checkpoint 4](2026-10-10-redesign.md#checkpoint-4-full-report-and-the-evidence-row), Tasks 4.1 to 4.3. This file adds the order, the rules and the decisions made since that plan was written. Where the two differ, this file wins.

- Spec: [redesign design](../../../specs/2026-10-10-redesign-design.md). Read decision 2 and the "Report view" part of the "Report" section, items 3 and 4.
- Approved demo: `demos/redesign/final/report.html`. It has the "Seller replied" button on the message card and the `#add` dialog. It has no evidence row and no full report section, so style those from the tokens in `src/app/[locale]/styles/tokens.css` and the card styles in `report-deck.css`. Add no new colors.
- Checkpoints 1 to 3 are merged into `redesign` (PR #23, PR #24, PR #26 and its fix PR #27).
- Agents: follow the [development agent policy](../../../../agent-policy.md). Each step names its role from that policy. One writer at a time.

## What you will see

Under the cards there is one slim row: "Seller replied or new photos?" with an "Add to the report" button, and the taustakontroll PDF upload. Retry and the Live diagnostics button sit in the same row when they apply. Below the row sits a closed "Full report" section. Opening it shows:

- every finding, grouped by area, with its next check and evidence;
- other and cleared observations;
- the per-photo review status;
- the listing facts, the sources and the methodology note.

All of it is in the new style. The message card has a "Seller replied" button that opens the same add-evidence dialog as the row. The old layout below the cards ("All checks", the separate photo list, the standalone upload sections and the footer) is gone. The progress journal above the cards keeps its look until checkpoint 5.

## How to check

1. Open a complete report. Below the cards, the add-evidence row is visible and "Full report" is closed.
2. Open "Full report". Each area shows its finding and photo counts. Open an area: its findings show the explanation, "Next check" and the evidence dialog.
3. Open the same report on `main` in a second tab. Every finding from the old "All checks" appears in the full report or on a card.
4. Press "Seller replied" on the message card. The dialog opens with the seller answer form. Close it, then press "Add to the report" in the row. The same dialog opens. Submit a seller answer. The dialog closes, a new run starts at the same address, and the cover shows the checking state.
5. Upload a taustakontroll PDF from the row. Then try a password-locked PDF and one over the size limit. Each is rejected with the existing error message.
6. Open a report whose review is incomplete and idle. The retry button sits in the row. On a running report there is no retry button.
7. With `LIVE_DIAGNOSTICS_ENABLED=true`, the Live diagnostics button sits in the row and opens the drawer.
8. Repeat in dark mode and with the Estonian interface. Report text keeps its own language. At 390px wide nothing scrolls sideways and every control in the row and the dialog is reachable.

## Decisions since the redesign plan

1. The message card gets the "Seller replied" button in this checkpoint. Checkpoint 3 did not add it, so `ReportDeck` has no `onSellerReplied` prop yet. Add `onSellerReplied?: () => void` to `ReportDeck` and `MessageCard`. The button renders only when the callback is given, so the deck stays independent of the dialog and renders without it offline (checkpoint 3 decision 3 still holds).
2. The Live diagnostics button moves from above the journal into the evidence row. Move the whole `DiagnosticsPanel` element unchanged. Do not edit its markup, because the diagnostics checkpoints build on it.
3. `SupplementForm` gets a `variant: "section" | "dialog"` prop, default `"section"`. In `"dialog"` it drops its own open toggle and visible heading (the dialog title replaces it) and calls a new `onSubmitted?: () => void` after a successful submit, so the dialog closes. The existing `router.refresh()` stays.
4. `RetryReview` is already hidden offline in `report-view.tsx` today. Keep that rule when moving it into the row, and keep its `key`.
5. `FullReport` also takes over the content that sat in "All checks" before the findings: the updated time and the review summary lines (state, images, text and final pass, unavailable or skipped photos). The footer's `compact.photoLimitations` note joins the methodology note at the end. Nothing from the old layout is dropped.
6. Line numbers in the redesign plan are out of date. Port tests by name, using the lists in Steps 1 and 2 below.
7. `EvidenceDisclosure` has a `findings` branch that uses `.primary-evidence-button`. No caller passes `findings` any more. Remove that branch with the CSS in Step 3, and check with `rg "findings=" src` first.

## Rules for every step

- Work in a worktree at `.worktrees/redesign-4` on branch `codex/redesign-full-report`. It starts from `redesign` with this plan as its only commit. The PR targets `redesign`. Do not push to `main` or `redesign`.
- Start only after the user approves checkpoint 4.
- Run tests from a worktree under `.worktrees/`. From a worktree nested deeper, such as `.claude/worktrees/`, the symlinked `node_modules` loads React twice and about 170 unrelated tests fail with `Cannot read properties of null (reading 'useContext')`.
- Keep every finding visible somewhere: on a card or in the full report (spec "Product rules"). The test `never drops a finding: every title appears on a card or below the cards` must keep passing, retargeted at the full report.
- Report-authored text keeps `lang={report.locale}`. Interface strings go in `messages/en.json` and `messages/et.json` under `Report.deck`, in both languages, in the same commit.
- The `offline` prop keeps hiding refresh, diagnostics, retry, every upload form, the evidence row, the dialog and the "Seller replied" button. The cards and the full report render offline.
- Keep `suppressHydrationWarning` on every `<details>` that moves, and the test `hydrates a Firefox-restored photo disclosure without resetting it or warning`.
- Add no dependencies. The dialog uses `@base-ui/react/dialog`, as `EvidenceDisclosure` does. Icons come from `@phosphor-icons/react`. Read `node_modules/next/dist/docs/` before using a Next.js API you have not used in this project.
- Design and check at 1280 to 1600px. At 390px nothing may scroll sideways. Phone layouts come in roadmap checkpoint 6.
- Interactive elements are at least 44px tall with a visible focus ring. Animations stop under `prefers-reduced-motion`.
- Write code comments and docs in plain English with no em dashes. UI copy uses no em dashes.
- Commit after each step with the message given. If a step's check fails and you cannot fix it within the step, stop and report what failed.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `git fetch origin` and `git worktree add .worktrees/redesign-4 codex/redesign-full-report`. Check that `git log --oneline origin/redesign..HEAD` lists only `docs:` commits. If `redesign` has moved on, merge `origin/redesign` first.
2. Symlink `node_modules` to the main checkout's and copy `.env.local`, as in `.worktrees/redesign-3`.
3. Run `npm test -- --maxWorkers=2` and write down the count. It must pass before any change. A single timeout in `tests/unit/worker/cli.test.ts` under full-suite load is known; rerun that file alone.
4. Write down `git rev-parse HEAD` as BASE.

## Step 1: Full report component

Role: small implementation changes and focused tests. Redesign plan Task 4.1, plus decisions 5 and 6.

1. Create `tests/unit/report/full-report.test.tsx` with the five tests from Task 4.1. Move these cases from `tests/unit/report/report-view.test.tsx` and render `FullReport` in them:
   - `starts with six collapsed groups and preserves findings when opened`
   - `keeps only uncategorized observations in Other without losing or duplicating findings`
   - `keeps every photo hidden until the photo dropdown opens`
   - `retains cleared findings in a collapsed disclosure`
   - `renders equal fact values from separate sources without a duplicate-key warning`
   - `shows each photo review state and a matching authenticated thumbnail`
   - `shows a translated unavailable message when a private photo cannot load`
   - `hydrates a Firefox-restored photo disclosure without resetting it or warning`
2. Run `npx vitest run tests/unit/report/full-report.test.tsx` and see the new tests fail.
3. Create `src/features/report/full-report.tsx` by moving the JSX from `ReportView`: the photo list section, the "All checks" content, the listing facts, the sources, the methodology note and the footer note. Move `factMessageKeys`, `factDisplayValue`, `factLabel` and `sourceLabel` with it. Its outer element is `<details className="full-report" suppressHydrationWarning>` with summary `deck.fullReport`. Inside, keep one closed `<details>` per area group, then other, cleared, photos, and listing and sources.
4. Create `src/app/[locale]/styles/full-report.css` and import it where `report-deck.css` is imported. Area rows sit on `--surface` with radius 20px and no doubled borders. Use only tokens. Replace the old utility classes on the moved JSX (`text-steel`, `text-pale-blue`, `text-amber`, `border-steel/*`) with classes from this file.
5. In `ReportView`, render `<FullReport report={report} locale={locale} />` under the deck and delete the moved JSX.
6. Run the new file, then the suite. Both pass.
7. Commit: `feat: move secondary report content into a closed full report section`.

## Step 2: Evidence row and supplement dialog

Role: integration. Redesign plan Task 4.2, plus decisions 1 to 4.

1. Create `tests/unit/report/evidence-row.test.tsx` with the four tests from Task 4.2, and add to `tests/unit/report/deck.test.tsx`: `shows the seller replied button only when a callback is given`. Move and retarget from `report-view.test.tsx`:
   - `keeps cards offline while hiding retry and upload controls` (also assert no row, no dialog and no "Seller replied" button)
   - `retries an incomplete review at the existing private report`
   - `places the seller-information action after the existing inspection report` (it now checks the order inside the row)
2. See them fail.
3. Implement:
   - `SupplementForm`: the `variant` and `onSubmitted` props from decision 3.
   - `TaustakontrollForm`: a `compact` prop. In compact mode the heading becomes the row's label text, the intro moves to the input's description, and the form fits on one line at desktop width. Errors and status lines stay as they are.
   - `src/features/report/supplement-dialog.tsx`: `SupplementDialog({ open, onOpenChange, publicId, reportStatus, reportUpdatedAt })`, a controlled `Dialog.Root` around `<SupplementForm variant="dialog" onSubmitted={() => onOpenChange(false)} />`. Title from the existing supplement `heading` string. Follow the portal, backdrop and close button of `EvidenceDisclosure`.
   - `src/features/report/evidence-row.tsx`: `EvidenceRow({ report, diagnosticsEnabled, onOpenSupplement })`. Order: the `deck.addEvidence` label with the `deck.addEvidenceAction` button, the compact taustakontroll form, then retry and `DiagnosticsPanel` when they apply.
   - `MessageCard` and `ReportDeck`: the `onSellerReplied` prop from decision 1. The button label is a new string `deck.sellerReplied` "Seller replied" / "Müüja vastas", with the paperclip icon, as in the demo.
   - `ReportView`: owns `supplementOpen` state. When not offline it renders `ReportDeck` with `onSellerReplied`, then `EvidenceRow`, then `FullReport`, and `SupplementDialog`. Remove the top-level `DiagnosticsPanel`, `TaustakontrollForm`, `SupplementForm` and the old review `<section>`.
4. Run the new tests and the suite. Both pass.
5. Commit: `feat: add the evidence row and the seller reply dialog`.

## Step 3: Delete the old structure and styles

Role: small implementation changes and focused tests.

1. In `src/app/[locale]/globals.css`, delete `.written-review`, `.primary-evidence`, `.primary-evidence-button`, `.report-footer` and the old `.report-shell` rules that set colors with old variables (`--off-white`, `--ink-navy`). Keep `.report-shell` width and padding if the page still needs them, using tokens. Keep `.vehicle-summary` and `.written-verdict`: `cover-card.tsx` still uses them.
2. Remove the `findings` branch from `EvidenceDisclosure` (decision 7).
3. For each deleted class, `rg` it in `src/` and `tests/`. No matches remain.
4. Run `npm test -- --maxWorkers=2` and `npm run build`. Both pass.
5. Commit: `refactor: remove the report layout replaced by the full report`.

## Step 4: Run the gates

Role: small implementation changes and focused tests.

`npm run lint`, `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build` and `git diff --check`. All pass. The lint warning in `demos/redesign/final/walk.js` is known.

## Step 5: Check it in the browser and save evidence

Role: manual frontend E2E and demo testing.

1. `npm run build`, then `npm run start -- -p 3000` and `npm run worker`. Restart `npm run start` after every rebuild; it serves the build that existed when it started.
2. Keep the browser tab in front. The report refresh pauses while a tab is hidden, including a hidden in-app browser pane, so a hidden tab looks stuck.
3. Run every "How to check" step against real reports and the real worker, including a real seller answer and a real PDF upload. Synthetic fixture routes are allowed only for states that cannot be reached otherwise, such as an incomplete idle review. Remove any such route before Step 6 and say so in the evidence.
4. Save screenshots at 1440x900 to `docs/superpowers/checkpoints/redesign-4/`: the row with the full report closed, the full report open with one area open, the dialog, and the message card with "Seller replied". Each in light and dark, ET and EN. Add one 390px capture of the row and one of the dialog.

## Step 6: Independent review

Role: independent code review. Review the whole branch against this file, the redesign plan tasks and the spec. Check in particular that no finding is lost, that offline hides every control listed in the rules, and that the diagnostics drawer markup is unchanged (`git diff origin/redesign -- src/features/diagnostics` is empty). Fix material findings and rerun the gates.

## Step 7: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/2026-10-12-redesign-4.md` with the gate results, test counts against BASE and the screenshot list, as in the checkpoint 3 evidence file.
2. In `docs/superpowers/roadmap.md`, set row 4 to "PR #N; user acceptance pending". In the "Open a saved report offline" scope, replace the sentence about hiding `RetryReview` with: the `offline` prop hides the evidence row, the supplement dialog, the "Seller replied" button, retry and diagnostics, and the full report renders offline.
3. Open the PR against `redesign` with `/pr`. Stop and wait for the user's check. Finishing this checkpoint does not approve checkpoint 5.
