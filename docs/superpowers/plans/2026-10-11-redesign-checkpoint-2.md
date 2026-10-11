# Redesign checkpoint 2: Start page and listing page

This is the step-by-step plan for Codex agents. It is roadmap checkpoint 2 and redesign plan checkpoint 2. It replaces the checkpoint 2 tasks in the [redesign plan](2026-10-10-redesign.md#checkpoint-2-start-page-and-listing-page).

- Spec: [redesign design](../specs/2026-10-10-redesign-design.md). Read its "Start page" and "Listing page" sections.
- Approved demo: `demos/redesign/final/`. Serve it with `python3 -m http.server 4317 --directory demos/redesign/final`. Open `#start` and `#capture`. The start page ships without the demo's photo and without its "Every point shows where it came from" section.
- Checkpoint 1 is merged into `redesign`. Use its tokens from `src/app/[locale]/styles/tokens.css` (`--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`, `--line`, `--accent`, `--accent-text`, `--attention`, `--shadow`, `--r-pill`, `--r-card`, `--r-photo`, `--ease-out`). Add no new colors.
- Agents: follow the [development agent policy](../../agent-policy.md). Each step names its role from that policy. Run the steps in order, one writer at a time.

## Revision on 2026-10-11

The user rejected the first listing page, which reused the demo's three-step progress bar. The spec now describes a different listing page (decisions 6 to 8 and the "Listing page" section), and the demo's `#capture` tab shows it. The start page work in Step 1 stands. The listing page steps below are replaced by the rework commits on this branch. The review step (decision 9) belongs to checkpoint 5, not this one.

## What you will see

The start page has a large left-aligned headline, the intro text and one pill-shaped address bar with the submit button inside it. "Continue manually" sits below. There is no photo.

The listing page is a quick check before the report. On the left is the first listing photo, large, with a row of thumbnails below it. On the right is a card that stays in view: the title, price, mileage and year, a line with fuel, gearbox, power and body type, the source link and captured time, then "Open inspection report" with one status line under it. Everything else is in a closed "All listing details" section below. While Auto24 is read, a line scans the photo slot and the text pulses. When the details arrive they fade in.

## How to check

1. Open `/et` and `/en`. The headline, intro and address bar show, with no photo.
2. Type "not a link" and submit. The error shows under the bar in the attention color, and the field is marked invalid.
3. Press "Continue manually". The manual form opens below.
4. Submit a real Auto24 link. On the listing page a line scans the photo slot, the text pulses and the status line counts the waiting time.
5. When the details arrive, the photo, thumbnails, title and figures fade in. Press a thumbnail: it shows in the large slot.
6. Open "All listing details". It has every photo, the vehicle details, description, equipment, technical details, other details, seller and Auto24 notes.
7. Scroll down. The card stays visible, and "Open inspection report" opens the report.
8. Open a capture that failed. The failure message shows in the attention color with "Submit this listing again" and no empty facts.
9. Repeat in dark mode and in Estonian.

## Rules for every step

- Work in the worktree `.worktrees/redesign-2` on branch `codex/redesign-start-listing`. It starts from `redesign` with documentation commits only, including this plan. Its PR targets `redesign`. Do not push to `main` or `redesign`.
- Start only when the roadmap shows checkpoint 2 as approved.
- Keep all existing copy, routes, data loading, polling and form behavior. New copy is limited to the listing page labels the spec names.
- Every listing page string lives in `src/features/listing/messages.ts`, in both the `english` and `estonian` objects.
- Add no dependencies. Read `node_modules/next/dist/docs/` before using a Next.js API you have not used in this project.
- Design and check at desktop width, 1280 to 1600px. At 390px wide, pages must not scroll sideways and every control must stay reachable. Phone layouts come in checkpoint 6.
- Animations stop under `prefers-reduced-motion`.
- Write code comments and docs in plain English with no em dashes.
- Commit after each step with the message given. If a step's check fails and you cannot fix it within the step, stop and report what failed.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `cd .worktrees/redesign-2`. Check that `git status` is clean and `git log --oneline origin/redesign..HEAD` lists only `docs:` commits. If `redesign` has moved on, merge `origin/redesign` into the branch first.
2. `node_modules` is already a symlink to the main checkout's, and `.env.local` is already copied. Check that both exist.
3. Run `npm test` and write down the test count. It must pass before you change anything.
4. Start a dev server on a free port, such as `npm run dev -- --port 3003`.
5. Write down `git rev-parse HEAD` as BASE.

## Step 1: Start page hero and address bar

Role: small implementation changes and focused tests.

**Files**
- Create `src/app/[locale]/styles/home.css`, imported in `globals.css` right after `tokens.css`.
- Edit `src/app/[locale]/page.tsx`.
- Edit `src/features/listing/submission-form.tsx`.
- Edit `src/features/submission/report-actions.tsx` (class names only).
- Create `tests/unit/listing/submission-form.test.tsx`.
- Edit `src/app/[locale]/globals.css`. Delete the `.home-content`, `.home-content h1`, `.lead-copy`, `.submission-panel`, `.form-controls` rules and any media-query lines that target them.

**Do**
1. `page.tsx`: replace `<section className="home-content">` and the `<div className="submission-panel">` wrapper with `<section className="home-hero">`. It holds the `h1` (`homeTitle`), `<p className="home-intro">` (`homeIntro`) and `<SubmissionForm>`. No image and no other section.
2. `submission-form.tsx`: keep the label, input, button, note, error and pending line, with their ids, `aria-*` attributes and order. Replace `<div className="form-controls">` with `<div className="url-bar">`. The input keeps `className="url-input"` and the button keeps `className="primary-button"`.
3. `report-actions.tsx`: give the "Continue manually" button `className="text-button"` in place of `secondary-button`. Keep `primary-button` on the report button and the manual form's submit button.
4. `home.css`:
   - `.home-hero`: `max-width: 760px; padding: clamp(48px, 10vh, 120px) 0 72px;`
   - `.home-hero h1`: `font-size: clamp(40px, 5.2vw, 68px); line-height: 1.02; letter-spacing: -0.045em; font-weight: 650; margin: 0 0 20px; text-wrap: balance;`
   - `.home-intro`: `font-size: 18px; line-height: 1.6; color: var(--text-2); max-width: 40ch; margin: 0 0 32px;`
   - `.url-bar`: `display: flex; gap: 6px; padding: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-pill); box-shadow: var(--shadow);`
   - `.url-bar:focus-within` uses `border-color: var(--accent)`. `.url-bar:has(.url-input[aria-invalid="true"])` uses `border-color: var(--attention)`.
   - `.url-bar .url-input`: `flex: 1; min-width: 0; border: 0; background: transparent; box-shadow: none;`. Remove its focus outline only inside the bar, because the bar shows focus.
   - `.text-button`: no background or border, `color: var(--text-2)`, `text-decoration: underline; text-underline-offset: 4px;`, `min-height: 44px`, and `color: var(--text)` on hover.
   - Below 560px wide, `.url-bar` switches to `flex-direction: column; border-radius: 22px; padding: 8px;` and its button goes full width.

**The tests** render `<SubmissionForm locale="en" />` with Testing Library. Mock `next/navigation` the way `tests/listing-dashboard-ui.test.ts` does. They check:
1. The input labelled "Auto24 listing URL" and the button "Get listing details" are both inside the same `.url-bar` element.
2. After typing "not a link" and submitting, the input has `aria-invalid="true"`, and an element with `role="alert"` shows the `invalidUrl` text from `messages.ts`.
3. The "Continue manually" button exists and has the class `text-button`.

**Check**
- The tests fail before the change and pass after.
- `npm test` passes.
- In the browser at 1440px, the start page matches the demo's `#start` hero, minus the photo, in light and dark mode.

Commit: `feat: start page hero with a pill address bar`

## Step 2: Capture steps

Role: small implementation changes and focused tests.

**Files**
- Create `src/features/listing/capture-steps.ts`.
- Edit `src/features/listing/messages.ts`.
- Create `tests/unit/listing/capture-steps.test.ts`.

**Do**
1. Write:

```ts
export type CaptureStepState = "waiting" | "active" | "done" | "failed";
export function captureSteps(
  status: "queued" | "running" | "completed" | "failed" | null,
): [CaptureStepState, CaptureStepState, CaptureStepState]
```

2. Add three strings to both objects in `messages.ts`:

| Key | English | Estonian |
| --- | --- | --- |
| `stepRequest` | Request received | Päring vastu võetud |
| `stepReading` | Reading the listing | Kuulutuse lugemine |
| `stepReady` | Details ready | Andmed valmis |

**The test**

```ts
it.each([
  [null, ["active", "waiting", "waiting"]],
  ["queued", ["active", "waiting", "waiting"]],
  ["running", ["done", "active", "waiting"]],
  ["completed", ["done", "done", "done"]],
  ["failed", ["done", "failed", "waiting"]],
] as const)("maps %s to the three steps", (status, expected) => {
  expect(captureSteps(status)).toEqual(expected);
});
```

**Check**: the test fails before the change and passes after. `npm run typecheck` passes, which confirms both message objects have the new keys.

Commit: `feat: map listing job status to three capture steps`

## Step 3: Split the listing page into parts

Role: small implementation changes and focused tests.

This step only moves code. The page must look and behave the same after it.

**Files**
- Edit `src/features/listing/formatters.ts`. Move `safeHttpUrl` and `formatNumber` here from `dashboard.tsx` and export them.
- Create `src/features/listing/capture-facts.tsx`. Move `factsFor` here from `dashboard.tsx` and export it.
- Edit `src/features/listing/dashboard.tsx` to import them.

**Check**
- `npm test` and `npm run typecheck` pass with no test changes.
- `git diff --stat` shows only these three files.

Commit: `refactor: move listing formatters and facts out of the dashboard`

## Step 4: Listing page components

Role: small implementation changes and focused tests.

**Files**
- Create `src/features/listing/capture-progress.tsx`.
- Create `src/features/listing/capture-photos.tsx`.
- Edit `src/features/listing/capture-facts.tsx`.
- Create `tests/unit/listing/capture-parts.test.tsx`.

**The components**

```ts
// capture-progress.tsx
export function CaptureProgress(props: {
  locale: Locale;
  status: "queued" | "running" | "completed" | "failed" | null;
  children: ReactNode; // the existing live status text, timing meta, slow note and resume button
}): JSX.Element
```

- Outer element: `<section className="capture-progress" aria-label={listingText(locale, "checking")}>`.
- Inside it, `<ol className="capture-steps">` holds three `<li>` elements with `data-state` from `captureSteps(status)`. Each `li` holds `<span className="capture-step-bar" aria-hidden="true" />` and a label (`stepRequest`, `stepReading`, `stepReady`). The `li` whose state is `active` or `failed` has `aria-current="step"`.
- Then `children`.

```ts
// capture-photos.tsx
export function CapturePhotos(props: {
  locale: Locale;
  photoUrls: string[] | null; // null while there is no listing yet
  waiting: boolean;           // true while the capture is queued or running
}): JSX.Element | null
```

- `<section className="capture-photos" aria-labelledby="photos-heading">` with `<h2 id="photos-heading">` using `photos`.
- When `photoUrls` is null and `waiting` is true: eight `<div className="photo-tile is-loading" aria-hidden="true" />` and one `<p className="sr-only">` with `unavailableForNow`.
- When `photoUrls` has items: one `<a className="photo-tile" href={url} target="_blank" rel="noreferrer">` per URL, each holding the existing `<img>` with its `alt`, `decoding` and `loading` attributes. Pass URLs through `safeHttpUrl` and drop the unsafe ones, as `ListingContent` does today.
- When `photoUrls` is an empty array: the `noPhotos` text.
- When `photoUrls` is null and `waiting` is false: render nothing.

```ts
// capture-facts.tsx
export function CaptureFacts(props: {
  locale: Locale;
  listing: Listing | null;
  waiting: boolean;
  children: ReactNode; // ReportActions
}): JSX.Element
```

- `<aside className="capture-facts" aria-labelledby="vehicle-details">` with `<h2 id="vehicle-details">` using `vehicleDetails`.
- A `<dl className="facts-list">` with every row from `factsFor` (13 rows). While `waiting` and `listing` is null, each value shows the existing `fact-placeholder` span and the `unavailableForNow` screen reader text, as `ListingSections` does today.
- Then `children`.

**The tests** render with `renderToStaticMarkup` or Testing Library. Reuse the `completedJob()` fixture from `tests/listing-dashboard-ui.test.ts`, by copying it or moving it into a shared helper. They check:
1. `CaptureProgress` sets the `data-state` values from `captureSteps` for `null`, `running`, `completed` and `failed`. For `failed`, the second `li` has `aria-current="step"`.
2. `CapturePhotos` renders eight `.photo-tile.is-loading` tiles while waiting, one link per safe photo URL when there are photos (keeping `http://images.example/car.jpg`), the `noPhotos` text for an empty list, and nothing when it is not waiting and has no photos.
3. `CaptureFacts` renders all 13 labels and the values "Example", "Touring", "2022" (not "2,022"), "41,500 EUR" and "46,800 km" for the fixture, and renders its children.

**Check**: the tests fail before the components exist and pass after. `npm test` passes.

Commit: `feat: add listing page progress, photo and facts components`

## Step 5: Listing page layout

Role: small implementation changes and focused tests.

**Files**
- Create `src/app/[locale]/styles/capture.css`, imported in `globals.css` after `home.css`.
- Edit `src/features/listing/dashboard.tsx`.
- Edit `tests/listing-dashboard-ui.test.ts`.
- Edit `src/app/[locale]/globals.css` (delete replaced rules, listed below).

**Do**
1. In `ListingDashboard`, after `<SiteHeader>`, replace `<div className="dashboard">` and its contents with `<div className="capture-layout">`. It has three children in this order:
   - `<div className="capture-head">`:
     - the existing title block from `.dashboard-heading`: `h1`, captured time, source address and the "Open original listing" link;
     - then `<CaptureProgress>`. Its `status` is `job?.status ?? null`. Its `children` are the existing elements from the old status panel: the live region with title and description, the timing meta, the slow note and the "Check again" button, unchanged.
   - `<CaptureFacts>`. Its `listing` is `listing`, its `waiting` is `!isTerminal`, and its `children` is the existing `<ReportActions … />`.
   - `<div className="capture-body">`:
     - `<CapturePhotos>`. Its `photoUrls` is `listing ? listing.photo_urls : null` and its `waiting` is `!isTerminal`.
     - Then the failed `notice-panel`, or `<ListingSections>`, exactly as today.
2. In `ListingSections`, remove the vehicle details section, because it moved to `CaptureFacts`.
3. In `ListingContent`, remove the photos section, because it moved to `CapturePhotos`.
4. Keep `data-state` on `.capture-progress` set the way the old status panel set it (`connection` when the notice says so, otherwise `job?.status ?? "running"`), so the attention color still applies to failed and connection states.
5. Do not change `ListingAccessFallback`.

**`capture.css`**
- `.capture-layout`:
  - `display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px 40px; margin-top: 32px;`
  - `grid-template-areas: "head facts" "body facts";`
- `.capture-head` uses `grid-area: head`, `.capture-body` uses `grid-area: body`.
- `.capture-facts`:
  - `grid-area: facts; align-self: start; position: sticky; top: 88px;`
  - `background: var(--surface); border-radius: var(--r-card); box-shadow: var(--shadow); padding: 22px;`
- `.facts-list`: two columns, `gap: 14px 16px`. `dt` is 13px in `var(--text-2)`. `dd` is `margin: 2px 0 0; font-weight: 600;`.
- Inside `.capture-facts`, the report buttons go full width and stack with an 8px gap.
- `.capture-head h1`: `font-size: clamp(30px, 3.6vw, 44px); letter-spacing: -0.04em; line-height: 1.05; font-weight: 650;`
- `.capture-steps`:
  - `display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; list-style: none; padding: 0; margin: 20px 0 8px;`
  - Each label is 14px. Labels are `var(--text-2)` except the `active` and `failed` steps, which use `var(--text)`.
- `.capture-step-bar`:
  - `display: block; height: 6px; border-radius: var(--r-pill); background: var(--surface-2); margin-bottom: 8px;`
  - With `data-state="done"` the bar is `var(--accent)`. With `active` it is `var(--accent)` at 50% width, using a `::after` scaled with `transform: scaleX(0.5)`. With `failed` it is `var(--attention)`.
- `.capture-photos`: a grid of 4 equal columns with a 10px gap.
- `.photo-tile`:
  - `aspect-ratio: 4 / 3; border-radius: var(--r-photo); overflow: hidden; background: var(--surface-2);`
  - Its `img` fills the tile with `object-fit: cover`.
- `.photo-tile.is-loading`: a shimmer made with a moving `linear-gradient` over `--surface-2` and `--surface`, 1.4s per pass. Under `prefers-reduced-motion` it shows no animation.
- Below 900px wide:
  - `.capture-layout` becomes one column with `grid-template-areas: "head" "facts" "body";`
  - `.capture-facts` is not sticky.
  - `.capture-photos` uses 2 columns.

**Delete from `globals.css`**: `.dashboard`, `.status-panel` and its `data-state` variants, `.dashboard-heading` and its children, `.fact-grid`, `.fact`, `.fact dt`, `.fact dd`, `.photo-grid`, `.photo-link`, `.photo-link img`, plus media-query lines for them. Keep `.status-main`, `.status-indicator`, `.status-title`, `.status-description`, `.status-meta`, `.status-slow` and `.status-action` if they are still used inside the progress block. Re-point their `[data-state]` selectors from `.status-panel` to `.capture-progress`. Keep `.fact-placeholder`.

**Tests**
- In `tests/listing-dashboard-ui.test.ts`, the first test no longer finds "Vehicle details", the make, the model or the photo inside `ListingSections`. Move those assertions to `capture-parts.test.tsx` (Step 4 already covers them), and keep the description, seller, equipment, technical details, other details, source link and warnings assertions where they are.
- Add a test that `ListingSections` no longer renders a `.fact-grid` or `.photo-grid`.

**Check**
- `npm test` passes.
- In the browser at 1440px, with a real listing:
  - the facts card stays in view while scrolling;
  - the steps advance from queued to completed;
  - photos replace the placeholders;
  - a failed capture shows the attention color on the reading step.
- At 390px wide, `document.documentElement.scrollWidth === window.innerWidth` is `true`.

Commit: `feat: two-column listing page with capture steps and a sticky facts card`

## Step 6: Run the gates

Role: small implementation changes and focused tests.

Run each command and keep the output for the PR:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`. The count must be at least the Step 0 count plus the new tests.
4. `npm run build`
5. `git diff --check`

Fix anything that fails, commit with `fix: <what you fixed>`, and run all five again.

## Step 7: Check it in the browser and save evidence

Role: manual frontend E2E and demo testing.

Run the dev server, the worker (`npm run worker`) and the Auto24 extraction service. Use one real Auto24 listing. Follow all seven "How to check" steps at the top, then:

1. At 1440×900, take screenshots in light and dark mode, in Estonian and English, of:
   - the start page;
   - the listing page while capturing (placeholders showing);
   - the listing page when completed.

   That makes 12 screenshots.
2. Take one screenshot of a failed capture, in dark mode, in English. To get one without breaking anything, submit a valid Auto24 address for a listing that no longer exists.
3. At 390×844, check that `document.documentElement.scrollWidth === window.innerWidth` on the start page and on the completed listing page, and take one Estonian screenshot of each.

Save the screenshots as JPG files in `docs/superpowers/checkpoints/redesign-2/`, named `<page>-<state>-<theme>-<lang>.jpg`, for example `listing-capturing-dark-et.jpg`. That is 15 files.

Done when all seven "How to check" steps pass and the 15 screenshots are saved. If a step fails, report it to the coordinator, who sends it back to the step that owns the code.

Commit: `docs: add redesign checkpoint 2 screenshots`

## Step 8: Independent review

Role: independent code review.

Give the reviewer:
- the diff `git diff BASE..HEAD`, with BASE from Step 0;
- this plan;
- the spec;
- the Step 6 output.

The reviewer checks:
- Each step's "Do" list is done, and no copy, route, polling or form behavior changed.
- No fact, photo, description, equipment, technical, other or seller detail that the old listing page showed is missing now.
- The live status region still announces status changes, and the "Check again" button still resumes polling.
- No new colors appear outside `tokens.css`. The `no-literal-colors` test still passes.
- The new tests check real behavior.

Fix every finding in a new commit, and send the fix diff back to the same reviewer until it is clean.

## Step 9: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/2026-10-11-redesign-2.md` in the style of `2026-10-11-redesign-1.md`. Include:
   - what changed;
   - the Step 6 results with test counts;
   - the browser check results;
   - links to the screenshots;
   - anything left for later checkpoints.
2. Push the branch and open a pull request against `redesign`, titled `Redesign checkpoint 2: start page and listing page`. The body has these sections:
   - "What you will see", copied from this plan;
   - "How to check", copied from this plan;
   - "Verification", with the commands and their results;
   - "Screenshots", as a table linking the files from Step 7;
   - "Not in this checkpoint": the report cards and phone layouts.

   Use plain language and no em dashes.
3. In `docs/superpowers/roadmap.md`, set checkpoint 2's status to "PR #<number>; user acceptance pending". Commit and push that change to the same branch.
4. Stop. Do not start checkpoint 3. The user will ask Claude to review the PR and will run the app themselves.
