# Redesign checkpoint 1: New look across the app

This is the step-by-step plan for Codex agents. It is roadmap checkpoint 2 and redesign plan checkpoint 1. It replaces the checkpoint 1 tasks in the [redesign plan](2026-10-10-redesign.md#checkpoint-1-new-look-across-the-app).

- Spec: [redesign design](../specs/2026-10-10-redesign-design.md). Read its "Visual system" section before you start.
- Approved demo: `demos/redesign/final/`. Serve it with `python3 -m http.server 4317 --directory demos/redesign/final`. Its `style.css` shows the target look.
- Agents: follow the [development agent policy](../../agent-policy.md). Each step below names its role from that policy. Run the steps in order, one writer at a time, because several steps edit `globals.css`.

## What you will see

Every page (start page, listing page and report) uses Geist, the new grey and white palette with a blue accent, pill-shaped buttons and inputs, and one shared header with the new logo mark and an ET/EN switch. Pages follow the computer's light or dark setting. Page layouts do not change yet.

## How to check

1. Start the app as described in [local development](../../local-development.md) and open `/et`. The header shows the logo mark, "Kontroll", "New listing" and ET/EN. Text is in Geist, not Arial.
2. Switch the computer between light and dark mode, or use DevTools Rendering to emulate `prefers-color-scheme`. The page changes theme without a reload.
3. Submit an Auto24 listing. The listing page and the report use the same header and colors in both themes.
4. On the report, the ET/EN switch opens the same report in the other language.
5. Press Tab through the start page. Every control shows a focus ring.
6. Open an Estonian report. Letters such as õ, ä, š and ž render in Geist, with no fallback glyphs.
7. Open a report whose review stopped or a capture that failed. The error text stands out in the attention color.

## Rules for every step

- Work in the worktree `.worktrees/redesign` on branch `codex/redesign-new-look`. It starts at the commit that added this plan. The commit before it holds the spec, the redesign plan and the demo. Do not push to `main`. Never delete remote branches.
- Do not change page layouts, copy, routes, data loading or component behavior. This checkpoint changes only colors, fonts, the header and control shapes.
- Read `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` before Step 2. The project runs Next.js 16, which differs from older versions.
- Add no dependencies. `next/font/google` ships with Next.js.
- Write code comments and docs in plain English with no em dashes.
- Commit after each step with the message given. End each commit message with the trailer your harness normally adds.
- If a step's check fails and you cannot fix it within the step, stop and report what failed. Do not skip ahead.

## Step 0: Prepare the worktree

Role: coordinator and planner.

1. `cd .worktrees/redesign` and check that `git log --oneline -1` shows `docs: add Codex step plan for redesign checkpoint 1`. Write down that commit's hash as BASE.
2. Install dependencies with `npm ci`, or symlink `node_modules` to the main checkout's `node_modules` as other Codex worktrees do.
3. Copy `.env.local` from the main checkout.
4. Run `npm test`. It must pass before you change anything. Write down the test count.
5. Pick a free port for this worktree's dev server, such as 3002, because another dev server may use 3000: `npm run dev -- --port 3002`.

Done when the suite passes and the dev server shows `/et` on your port.

## Step 1: Add the design tokens

Role: small implementation changes and focused tests.

**Files**
- Create `src/app/[locale]/styles/tokens.css`.
- Create `tests/unit/styles/tokens.test.ts`.
- Edit `src/app/[locale]/globals.css`. Add `@import "./styles/tokens.css";` as the first line after the existing `@import` lines, and delete the old `:root { ... }` block (the one that sets `color-scheme: dark` and `--ink-navy` through `--quiet-border`).

**Write `tokens.css` exactly like this:**

```css
/* Redesign tokens. Values come from docs/superpowers/specs/2026-10-10-redesign-design.md. */
:root {
  color-scheme: light dark;
  --bg: #f4f4f2;
  --surface: #ffffff;
  --surface-2: #ebebe8;
  --text: #17181a;
  --text-2: #5b5e63;
  --line: rgb(23 24 26 / 10%);
  --accent: #3050d0;
  --accent-text: #ffffff;
  --accent-soft: rgb(48 80 208 / 9%);
  --attention: #9a5b0c;
  --shadow: 0 1px 2px rgb(30 34 60 / 6%), 0 12px 32px -12px rgb(30 34 60 / 18%);
  --r-pill: 999px;
  --r-field: 14px;
  --r-card: 20px;
  --r-deck: 28px;
  --r-photo: 14px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1);

  /* Old names. Existing Tailwind classes such as text-steel still use them. Remove in redesign checkpoint 5. */
  --ink-navy: var(--bg);
  --blue-gray: var(--surface-2);
  --off-white: var(--text);
  --steel: var(--text-2);
  --pale-blue: var(--accent);
  --amber: var(--attention);
  --border: var(--line);
  --quiet-border: var(--line);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1012;
    --surface: #17181b;
    --surface-2: #202226;
    --text: #ecedef;
    --text-2: #a2a6ad;
    --line: rgb(236 237 239 / 10%);
    --accent: #7d95ff;
    --accent-text: #0f1012;
    --accent-soft: rgb(125 149 255 / 12%);
    --attention: #e8b878;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 12px 32px -12px rgb(0 0 0 / 60%);
  }
}
```

**The test** reads `tokens.css` with `fs`, takes the first `:root { ... }` block as the light theme and the `:root { ... }` block inside `@media (prefers-color-scheme: dark)` as the dark theme, and parses `--name: value;` pairs. It has a small WCAG contrast helper for hex colors. It checks:

1. Each of `--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`, `--line`, `--accent`, `--accent-text`, `--accent-soft`, `--attention` and `--shadow` is set in both themes.
2. In both themes, each of these pairs has a contrast of at least 4.5:
   - `--text` on `--bg` and on `--surface`
   - `--text-2` on `--bg`, `--surface` and `--surface-2`
   - `--accent` on `--bg` and on `--surface`
   - `--accent-text` on `--accent`
   - `--attention` on `--bg` and on `--surface`

**Check**
- Write the test first and run `npx vitest run tests/unit/styles/tokens.test.ts`. It fails because the file is missing.
- Add `tokens.css` and the import. The test passes.
- `npm test` passes.

Commit: `feat: add redesign color tokens for light and dark themes`

## Step 2: Load Geist and declare both color schemes

Role: small implementation changes and focused tests.

**Files**
- Edit `src/app/[locale]/layout.tsx`.
- Edit `src/app/[locale]/globals.css` (the `@theme inline` block and the `body` rule).
- Create `tests/unit/styles/layout-fonts.test.ts`.

**Do**
1. In `layout.tsx`, import `Geist` and `Geist_Mono` from `next/font/google`. Call each once at module level:
   - `Geist({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-geist" })`
   - `Geist_Mono({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-geist-mono" })`

   Estonian needs `latin-ext` for `š` and `ž`.
2. Put both `.variable` class names on the `<html>` element.
3. Add `export const viewport: Viewport = { colorScheme: "light dark" };` with `import type { Viewport } from "next";`.
4. In the `@theme inline` block of `globals.css`, add `--font-sans: var(--font-geist), system-ui, sans-serif;` and `--font-mono: var(--font-geist-mono), ui-monospace, monospace;`. Change `--color-input: var(--steel);` to `--color-input: var(--line);`.
5. In the `body` rule, replace `font-family: Arial, Helvetica, sans-serif;` with `font-family: var(--font-geist), system-ui, sans-serif;`.

**The test** reads `layout.tsx` and `globals.css` as text, in the same style as `tests/listing-page-source.test.ts`. It checks:
- `layout.tsx` imports `Geist` and `Geist_Mono` from `"next/font/google"`.
- `layout.tsx` contains `"latin-ext"`, `--font-geist`, `--font-geist-mono` and `colorScheme: "light dark"`.
- `globals.css` no longer contains `Arial`.

**Check**
- The test fails before the change and passes after.
- `npm run build` passes. The first build downloads the fonts, so it needs network access.
- In the browser, DevTools shows the computed font of body text as Geist.

Commit: `feat: load Geist and Geist Mono and follow the system color scheme`

## Step 3: Replace hard-coded colors

Role: small implementation changes and focused tests.

**Files**
- Edit `src/app/[locale]/globals.css`.
- Edit `src/features/report/report-view.tsx` (two class names only).
- Create `tests/unit/styles/no-literal-colors.test.ts`.

**Do**
1. Base rules in `globals.css`:
   - `html, body` background becomes `var(--bg)`.
   - `body` color becomes `var(--text)`.
   - The focus rule becomes `outline: 2px solid var(--accent); outline-offset: 3px;`.
   - `::selection` becomes `background: var(--accent); color: var(--accent-text);`.
2. In the report rules, delete the local override `--ink-navy: #17202c;` from `.report-shell`, delete the whole `body:has(.report-shell)` rule, and delete the `.report-language` and `.report-language a` rules.
3. Replace every other hex color left in `globals.css`. Use this table:

| Hex | Where it is used | Replace with |
| --- | --- | --- |
| `#39495f` | report header border | `var(--line)` |
| `#c4ccd5`, `#bcc6d0`, `#aebac7` | vehicle summary, status line, evidence caption, footer | `var(--text-2)` |
| `#e1e5ea` | written review paragraphs | `var(--text)` |
| `#6d83a0` | evidence button border | `var(--line)` |
| `#aac9ff` | evidence button text, running photo state | `var(--accent)` |
| `#222f41` | photo state circle background | `var(--surface-2)` |
| `#8ad5b4` | finished activity steps, finished photo state | `var(--accent)` |
| `#86efac` | finished and reused diagnostics states | `var(--accent)` |
| `#c9d2d0` | waiting activity dots and dashed lines | `var(--text-2)` |

   Finished states use the accent color. There is no separate success color.
4. In `.report-shell .brand`, remove `font-size: 30px; font-weight: 700;` so the report header matches the other pages.
5. In `report-view.tsx`, change `text-green-400` to `text-pale-blue` and `text-orange-400` to `text-steel`.

**The test** checks:
- `globals.css` contains no hex color: no match for `/#[0-9a-fA-F]{3,8}\b/`.
- No `.tsx` file under `src/` contains `text-green-`, `text-orange-`, `text-red-`, `bg-green-`, `bg-orange-` or `bg-red-`.

**Check**
- The test fails before the change and passes after.
- `npm test` passes.
- In the browser, open a report in light and in dark mode. No dark navy patch remains, and the text is readable in both.

Commit: `fix: replace hard-coded colors with redesign tokens`

## Step 4: One shared header

Role: small implementation changes and focused tests.

**Files**
- Create `src/components/site-header.tsx`.
- Create `tests/unit/components/site-header.test.tsx`.
- Edit `src/app/[locale]/page.tsx`. Remove the local `LanguageLinks` function and the inline `<header>`.
- Edit `src/features/listing/dashboard.tsx`. Remove the local `LanguageLinks` and `SiteHeader` functions and use the new component in both places that used them.
- Edit `src/app/[locale]/r/[publicId]/page.tsx`. Replace the inline `<header>`, including the hard-coded "Car review" text.
- Edit `src/app/[locale]/globals.css` (the header rules).

**The component**

```ts
export function SiteHeader(props: {
  locale: Locale;                         // from "@/features/listing/messages"
  languageHrefs: Record<Locale, string>;  // where the ET and EN links go
  showNewListing?: boolean;               // default false
}): JSX.Element
```

- Outer element: `<header className="site-header">`.
- Brand: `<Link className="brand" href={`/${locale}`}>`. It holds an inline SVG logo mark and the text `listingText(locale, "brand")`. The SVG is 22×22 with `aria-hidden="true"` and `viewBox="0 0 24 24"`. It draws a `<rect x="2" y="2" width="20" height="20" rx="7" fill="var(--accent)" />` and a check `<path d="M7.5 12.4l3 3 6-6.8" stroke="var(--accent-text)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />`.
- Right side: `<div className="header-actions">`.
  - When `showNewListing` is true, it first holds `<Link className="new-listing-link" href={`/${locale}`}>` with `listingText(locale, "newListing")`.
  - Then `<nav className="language-switch" aria-label={listingText(locale, "languageLabel")}>` with two links, "ET" and "EN". Each `href` comes from `languageHrefs`, and the link for the current locale has `aria-current="page"`.

**Use it**

| Page | `languageHrefs` | `showNewListing` |
| --- | --- | --- |
| Start page | `{ et: "/et", en: "/en" }` | false |
| Listing page and its access fallback | `/${l}/a/${encodeURIComponent(jobId)}` for each language | true |
| Report page, every state | `/${l}/r/${publicId}` for each language | true |

Both report addresses work, because the access cookie path is `/`.

**Header styles in `globals.css`**
- `.site-header`:
  - `position: sticky; top: 0; z-index: 10;`
  - `min-height: 64px;`
  - `background: color-mix(in srgb, var(--bg) 86%, transparent); backdrop-filter: blur(14px);`
  - `border-bottom: 1px solid var(--line);`
  - Keep the existing flex row.
- `.brand`: `display: inline-flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 650; letter-spacing: -0.02em;`
- `.language-switch a`: `min-width: 40px; min-height: 40px; border-radius: var(--r-pill); color: var(--text-2);`
- `.language-switch a[aria-current="page"]`: `color: var(--text); background: var(--surface-2);`
- `.new-listing-link`: `color: var(--text-2);` and `color: var(--text);` on hover.
- Change the report header's bottom margin from `65px` to `40px`. Keep its padding.

**The tests**
1. The brand link points to `/${locale}`, and its accessible name contains "Kontroll".
2. With `locale="et"`, the "ET" link has `aria-current="page"` and the "EN" link does not.
3. Each language link uses the matching `languageHrefs` value.
4. The "New listing" link (Estonian: the `newListing` string from `src/features/listing/messages.ts`) shows only when `showNewListing` is true.

**Check**
- The tests fail before the component exists and pass after.
- `npm test` passes.
- In the browser, the start page, the listing page and the report page show the same header. On the report, EN and ET switch the language of the same report.

Commit: `feat: share one header across start, listing and report pages`

## Step 5: Pill buttons, rounded fields and soft panels

Role: small implementation changes and focused tests.

**Files**
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/textarea.tsx`
- `src/features/report/seller-message.tsx`
- `src/features/report/evidence-disclosure.tsx`
- `src/features/supplements/supplement-form.tsx`
- `src/features/supplements/taustakontroll-form.tsx`
- `src/app/[locale]/globals.css`

**Do**
1. `button.tsx`:
   - In the base class string, change `rounded-lg` to `rounded-full` and `text-sm font-medium` to `text-[15px] font-semibold`.
   - Change `active:not-aria-[haspopup]:translate-y-px` to `active:not-aria-[haspopup]:scale-[0.98]`.
   - Sizes: `default` becomes `min-h-11 gap-2 px-5`, `sm` becomes `min-h-9 gap-1.5 px-4 text-sm`, `lg` becomes `min-h-12 gap-2 px-6`, `icon` becomes `size-11`. Remove the `rounded-[min(...)]` parts from `xs`, `sm`, `icon-xs` and `icon-sm`.
   - Variants: `default` stays `bg-primary text-primary-foreground` with hover `hover:bg-primary/90`. `outline` becomes `border-border bg-transparent hover:bg-secondary aria-expanded:bg-secondary`.
   - Delete every `dark:` class in the file. The tokens already switch per theme.
2. `input.tsx` and `textarea.tsx`:
   - Change `rounded-lg` to `rounded-[14px]` and `bg-transparent` to `bg-[var(--surface)]`.
   - `input.tsx` only: change `h-8` to `min-h-11` and `px-2.5` to `px-3.5`.
   - Delete every `dark:` class.
3. In the four feature files, remove `rounded-sm` from every `<Button>`, `<Input>` and `<Textarea>`. On other elements, replace it with `rounded-[14px]`: the native field at `supplement-form.tsx` line 209 and the image and its fallback at `evidence-disclosure.tsx` lines 121 and 122.
4. In `globals.css`:
   - `.primary-button`:
     - `min-height: 48px; padding: 0 22px;`
     - `border: 0; border-radius: var(--r-pill);`
     - `background: var(--accent); color: var(--accent-text);`
     - `font-size: 15px; font-weight: 600;`
     - `transition: transform .35s var(--ease-spring), background .25s var(--ease-out);`
     - `:hover` uses `transform: translateY(-1px)`, and `:active` uses `transform: scale(0.98)`.
     - Keep the existing disabled rule and its `wait` cursor.
   - `.secondary-button`: the same shape, with `background: var(--surface-2); color: var(--text); border: 0;`.
   - `.url-input`:
     - `min-height: 48px; padding: 0 16px;`
     - `border: 1px solid var(--line); border-radius: var(--r-pill);`
     - `background: var(--surface); color: var(--text);`
     - On focus, `border-color: var(--accent)`. With `aria-invalid="true"`, `border-color: var(--attention)`.
   - `.status-panel`, `.notice-panel`, `.access-panel`:
     - `background: var(--surface); border-radius: var(--r-card); box-shadow: var(--shadow);`
     - Remove the 2px colored left edge.
     - In `.status-panel[data-state="failed"]` and `.status-panel[data-state="connection"]`, color the `.status-title` with `var(--attention)`. The queued state uses normal text.
   - `.form-error` color is `var(--attention)`.

**Check**
- `npm test` passes. If a test asserted a removed class name, change it to assert the behavior instead, and list that change in the PR.
- `npm run typecheck` passes.
- In the browser, every button is a pill, inputs have round corners, and panels are soft cards without a colored left edge, in both themes.

Commit: `feat: restyle buttons, fields and panels for the redesign`

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

Use the dev server from Step 0, the worker (`npm run worker`) and one real Auto24 listing. Follow the "How to check" list at the top, all seven steps, and also:

1. Set the window to 1440×900. Take screenshots of the start page, a listing page and a finished report, in light and dark mode, in Estonian and English. That makes 12 screenshots.
2. Set the window to 390×844. On each of the three pages, run `document.documentElement.scrollWidth === window.innerWidth` in the console. It must be `true`. Take one screenshot per page in Estonian.
3. Open Live diagnostics with `LIVE_DIAGNOSTICS_ENABLED=true`. The drawer opens and is readable in both themes.

Save the screenshots as JPG files in `docs/superpowers/checkpoints/redesign-1/`, named `<page>-<theme>-<lang>.jpg` (for example `report-dark-et.jpg`) and `<page>-phone-et.jpg`.

Done when all seven "How to check" steps pass and the 15 screenshots are saved. If a step fails, report it to the coordinator, who sends it back to Step 3, 4 or 5.

Commit: `docs: add redesign checkpoint 1 screenshots`

## Step 8: Independent review

Role: independent code review.

Give the reviewer:
- the diff `git diff BASE..HEAD`, with BASE from Step 0;
- this plan;
- the spec;
- the Step 6 output.

The reviewer checks:
- Each step's "Do" list is done, and nothing outside it changed (no layout, copy or behavior changes).
- No hex colors remain outside `tokens.css`. No `dark:` classes remain in the three UI primitives.
- The header links are correct on all three pages, including the report's access-denied and pending states.
- The new tests check real behavior. A test that would pass with an empty file is not acceptable.

Fix every finding in a new commit, and send the fix diff back to the same reviewer until it is clean.

## Step 9: Report and pull request

Role: coordinator and planner.

1. Write `docs/superpowers/checkpoints/2026-10-11-redesign-1.md` in the style of `2026-10-09-live-diagnostics-1.md`. Include:
   - what changed;
   - the Step 6 results with test counts;
   - the browser check results;
   - links to the screenshots;
   - anything left for later checkpoints.
2. In `docs/superpowers/roadmap.md`, set checkpoint 2's status to "PR #<number>; user acceptance pending" once the PR exists.
3. Push the branch and open a pull request against `main`, titled `Redesign checkpoint 1: new look across the app`. The body has these sections:
   - "What you will see", copied from this plan;
   - "How to check", copied from this plan;
   - "Verification", with the commands and their results;
   - "Screenshots", with links to the files from Step 7;
   - "Not in this checkpoint": layouts, the report cards and phone layouts.

   Use plain language and no em dashes.
4. Stop. Do not start checkpoint 2. The user will ask Claude to review the PR and will run the app themselves.
