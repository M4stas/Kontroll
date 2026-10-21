# Redesign checkpoint 6: Phone layouts

This is the step plan for Codex agents. It is roadmap checkpoint 6. The redesign is merged into `main` (PR #32), so this checkpoint branches from `main` and opens its PR against `main`.

- Spec: [redesign design](../../../specs/2026-10-10-redesign-design.md). Read decision 5 and the "Visual system" section.
- Desktop demo: `demos/redesign/final/`. Serve it with `python3 -m http.server 4317 --directory demos/redesign/final`.
- Design record: `DESIGN.md`.
- Agents: follow the [development agent policy](../../../../agent-policy.md). Each step names its role from that policy. One writer at a time.

The work has two parts with a stop between them. Part A is the design round the roadmap asks for in "Before starting". Part B builds the approved design. Part B starts only after the user approves the phone demos.

## What you will see

On a phone, every page uses a layout made for a narrow screen:

- **Start page:** the hero text and the address bar stacked, the bar full width with the submit button inside it.
- **Listing page:** the photos as a full-width swipe gallery, the car details below, and the report button with its status line in a bar fixed to the bottom of the screen.
- **Review step:** the three bars stacked, the photo grid in two columns, and "Open the report" in the bottom bar.
- **Report:** one card fills the screen. A one-finger swipe moves between cards. Back, Next and the progress dots sit in the bottom bar. The checklist ticks are large enough for a thumb, and the message card's copy button sits within thumb reach. The evidence row and the Full report stack in one column.
- **Live diagnostics:** a full-screen sheet.

Desktop and tablet layouts do not change.

## How to check

1. Start the app with `npm run build` and `npm run start -- -H 0.0.0.0 -p 3000`, and start the worker with `npm run worker`. On the phone, open `http://<this Mac's address>:3000`. The phone and the Mac need to be on the same network.
2. In DevTools device mode at 390px, open the start page, a listing page while it is reading and after it finishes, a running review and a finished report. Nothing scrolls sideways, and the bottom bar never covers content you need.
3. On a real iPhone and a real Android phone, submit a listing, open the report and swipe through the cards with one finger. Back and Next stay on screen.
4. Hold the phone in one hand and tick the checklist with your thumb.
5. Copy the seller message and paste it into the Auto24 app.
6. Open Live diagnostics. It covers the screen and closes with its close button.
7. Repeat in dark mode and in Estonian.
8. Open the same pages on a desktop at 1440px. They look exactly as before.

## Rules for every step

- Phone layout applies at `max-width: 639px`, as one shared breakpoint. Existing rules at 560px, 640px and 760px are merged into it or left alone if they only affect wider screens. Tablet and desktop rendering must not change. Prove it with before and after screenshots at 1440px and 768px.
- Design at 390x844. Check at 360x740 and 430x932. Landscape phones must still work without sideways scrolling.
- No change to behavior, data, routes or copy meaning. New strings only where a layout needs a shorter label, in both languages.
- Bottom bars use `env(safe-area-inset-bottom)`. Add `viewportFit: "cover"` to the `viewport` export in `src/app/[locale]/layout.tsx` only if the bars need it, and keep `colorScheme`.
- Touch targets are at least 44x44px with a visible focus ring. Animations stop under `prefers-reduced-motion`.
- The card row keeps its native horizontal scroll with snapping. Do not add a gesture library. Vertical scrolling inside a long card must not trigger a card change.
- Add no dependencies. Icons come from `@phosphor-icons/react`. Read `node_modules/next/dist/docs/` before using a Next.js API you have not used in this project.
- Run tests from a worktree under `.worktrees/`. From a worktree nested deeper, the symlinked `node_modules` loads React twice and unrelated tests fail.
- Use the internal browser for every browser test it supports. Use Brave only when the internal browser cannot do the test. Never use Firefox.
- Manual checks use Auto24 links the user gives you. Do not pick listings yourself.
- Write code comments and docs in plain English with no em dashes. UI copy uses no em dashes.
- Commit after each step with a short conventional message. If a step's check fails and you cannot fix it within the step, stop and report what failed.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `git fetch origin`. Create `.worktrees/redesign-6` on a new branch `codex/redesign-phone-layouts` from `origin/main`.
2. Symlink `node_modules` to the main checkout's and copy `.env.local`, as in earlier redesign worktrees.
3. Run `npm test -- --maxWorkers=2` and write down the count. It must pass before any change.
4. Take baseline screenshots of the start page, a listing page, a running review and a finished report at 1440x900 and 768x1024, light mode, English. Save them outside the repo for the comparison in Step 8.

## Part A: Design round

## Step 1: Phone demos

Role: not in the allocation table, so it inherits the current chat's model. Use the Impeccable skill, as the desktop demos were made.

1. Copy `demos/redesign/final/` to `demos/redesign/phone/`. Keep the Passat content and the Wikimedia photos. Add a phone frame page, `demos/redesign/phone/index.html`, that shows each screen in a 390x844 frame side by side, with a link to open each one at full size.
2. Build these screens, each in light and dark:
   - start page;
   - listing page while reading, after it finishes, and failed;
   - review step mid-run;
   - report: cover, one finding card, message card, checklist card, then the evidence row and the open Full report;
   - Live diagnostics sheet.
3. Where the questions below have a real choice, show both options as `A` and `B` on the frame page. Mark the recommended option.

| Question | A (recommended) | B |
| --- | --- | --- |
| Listing photos | Full-width swipe gallery with a "3 / 18" count | Large first photo with a thumbnail strip |
| Report button on the listing page | Bottom bar with the status line | In the page flow under the details |
| Report card height | Card fills the screen above the bottom bar; a long card scrolls inside itself | Card grows with its content; the page scrolls |
| Back and Next | Bottom bar with Back, the progress dots and Next | Under each card |
| Header | Logo mark and ET/EN; "New listing" as an icon button | Same as desktop, wrapped |

4. Stop. Give the user the command to serve the demo, the frame page address and the list of questions. Do not start Part B.

## Step 2: Record the decisions

Role: coordinator and planner. Only after the user picks.

1. Add the user's choices to the spec as numbered decisions after decision 9, with the date. Write down anything the user changed by hand.
2. Add a "Phone layout" section to `DESIGN.md`: the breakpoint, the bottom bar, card height and the gallery.
3. Commit the demo, the spec and `DESIGN.md` together.

## Part B: Build

Each step adds phone rules for one page and its tests. Prefer CSS in `src/app/[locale]/globals.css` under the shared breakpoint. Change markup only where CSS cannot reach the approved layout, such as moving the report button into a bottom bar.

## Step 3: Shared parts

Role: small implementation changes and focused tests.

The header, the bottom bar container (one component used by the listing page, the review step and the card row, with safe-area padding and a spacer so content is not covered), and the diagnostics drawer as a full-screen sheet. Test that the bottom bar renders its children and that the page adds the spacer.

## Step 4: Start page and listing page

Role: small implementation changes and focused tests.

Files: `src/features/listing/listing-gallery.tsx`, `listing-card.tsx`, `listing-details.tsx`, `dashboard.tsx`, and the start page under `src/app/[locale]/page.tsx`. The gallery count updates as the user swipes. The report button and its status line move into the bottom bar on phones only. The failed state keeps "Try another listing" reachable. Extend `tests/listing-dashboard-ui.test.ts` for the bottom bar and the gallery count.

## Step 5: Review step

Role: small implementation changes and focused tests.

File: `src/features/report/report-progress.tsx`. "Open the report", its status line, Retry and Live diagnostics move into the bottom bar on phones. The grid stays at two columns. Extend the existing review view tests.

## Step 6: Report cards, evidence row and Full report

Role: integration.

Files: `src/features/report/deck/*.tsx`, `evidence-row.tsx`, `full-report.tsx`. Card height, the bottom bar with Back, the dots and Next, large checklist ticks and the copy button within thumb reach. A swipe changes the current card and the dots, and keyboard navigation still works on desktop. Vertical scrolling inside a card does not change the card. Extend the deck tests for the current-card marker after a scroll.

## Step 7: Run the gates

Role: small implementation changes and focused tests.

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. Compare the test count with Step 0.

## Step 8: Check it in the browser and save evidence

Role: manual frontend E2E and demo testing.

1. Run every "How to check" step that works without a real phone, at 390x844, 360x740 and 430x932, with links the user gives you.
2. Save screenshots at 390x844 to `docs/superpowers/checkpoints/redesign-6/`: start, listing reading and finished, review mid-run, each card, the evidence row and the open Full report, and the diagnostics sheet. Each in light and dark, ET and EN.
3. Retake the Step 0 screenshots at 1440x900 and 768x1024 and compare. List any difference. Any difference is a bug unless the user approved it.

## Step 9: Finish review

Role: not in the allocation table, so it inherits the current chat's model.

Run the Impeccable finish review against the spec, `demos/redesign/phone/` and the Step 8 screenshots. Fix its material findings, rerun the gates and replace any screenshots that changed.

## Step 10: Independent review

Role: independent code review. Check in particular:

- no layout change above 639px;
- no content hidden behind the bottom bar at any checked size;
- every control reachable and at least 44px on phones;
- the card row still works with the keyboard and with a trackpad on desktop;
- offline reports still hide the same controls.

Fix material findings and rerun the gates.

## Step 11: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/<date>-redesign-6.md` with the gate results, test counts, the desktop comparison and the screenshot list.
2. In `docs/superpowers/roadmap.md`, set row 6 to "PR #N; user acceptance pending" and point its Source column at this file.
3. Open the PR against `main` with `/pr`. Stop and wait for the user to check on real phones.
