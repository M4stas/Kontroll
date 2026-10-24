---
name: Kontroll
description: Evidence to take to a used-car viewing.
colors:
  accent: "#3050d0"
  accent-text: "#ffffff"
  accent-soft: "rgb(48 80 208 / 9%)"
  attention: "#9a5b0c"
  bg: "#f4f4f2"
  surface: "#ffffff"
  surface-2: "#ebebe8"
  text: "#17181a"
  text-2: "#5b5e63"
  line: "rgb(23 24 26 / 10%)"
  dark-accent: "#7d95ff"
  dark-accent-text: "#0f1012"
  dark-accent-soft: "rgb(125 149 255 / 12%)"
  dark-attention: "#e8b878"
  dark-bg: "#0f1012"
  dark-surface: "#17181b"
  dark-surface-2: "#202226"
  dark-text: "#ecedef"
  dark-text-2: "#a2a6ad"
  dark-line: "rgb(236 237 239 / 10%)"
typography:
  display:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(40px, 5.2vw, 68px)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  verdict:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(48px, 8vw, 96px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(30px, 3.6vw, 44px)"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  figures:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
rounded:
  pill: "999px"
  field: "14px"
  card: "20px"
  deck: "28px"
  photo: "14px"
  equipment-tag: "3px"
spacing:
  tight: "6px"
  photo-gap: "10px"
  control-gap: "12px"
  group: "16px"
  section: "24px"
  review-gap: "32px"
  desktop-gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  input-url:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "48px"
  report-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.deck}"
  equipment-tag:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.equipment-tag}"
    padding: "5px 8px"
---

# Design System: Kontroll

## Overview

**Creative North Star: "Evidence at hand"**

Kontroll gives a buyer a calm place to read a listing, inspect its photos and carry the resulting questions to a viewing. Light surfaces, generous type and a single blue accent make the evidence easy to find. Dark mode uses the same hierarchy and geometry with a darker set of surfaces.

This record describes the implemented redesign through checkpoint 6, phone layouts. The source of the tokens is `src/app/[locale]/styles/tokens.css`; component styles live beside it. The approved visual reference is `demos/redesign/final/`. The production home was also observed in the internal browser at 1440 × 900 in dark mode, confirming the installed Geist face and the dark background, text and accent tokens. Report and review geometry here is recorded from the built component source.

**Key Characteristics:**

- Large, direct headings and readable explanations.
- Real listing photos, with an area icon when a finding has no photo.
- Rounded surfaces, quiet rules and soft elevation.
- One accent for actions, progress and evidence links; an attention color for stopped work and unavailable information.
- The same interface structure in Estonian and English.

**The Evidence Rule.** Every finding remains available on a card or in the Full report. Presentation never replaces the underlying observation.

## Colors

The frontmatter records light values and their `dark-` counterparts. The operating system selects the theme through `prefers-color-scheme`; components use the shared CSS custom properties rather than choosing a palette themselves.

Primary roles are the blue accent, its contrasting text and its soft tint. The accent marks the main action, progress fills, evidence links and keyboard focus. Attention marks unavailable photos, stale or stopped work, and errors.

Neutral roles are the page background, the raised surface, the secondary surface, primary and secondary text, and a quiet dividing line. The secondary surface holds waiting photos, form fields and the quieter half of a split card. The dark theme changes these roles together.

**The Role Rule.** Use `--accent` for an action or an evidence connection and `--attention` for a state that needs the buyer's attention. Use `--text-2` for supporting copy, not for conclusions that must be read.

## Typography

Geist is loaded through Next.js with Latin and Latin Extended subsets. Geist Mono is reserved for listing figures and compact factual values. The body remains a readable sans serif.

The front page display is the largest introductory voice. The report cover gives the verdict its own scale. Finding headings and the review title share a smaller display scale; the review title uses a slightly tighter line height (1.05). Explanations use the body role, while progress details, evidence controls and status copy use smaller labels.

**The Reading Rule.** Keep explanations intact, with a comfortable measure of up to 65 characters where the component allows it. Do not truncate a saved finding to make a card shorter.

Report-authored titles, explanations and facts carry the report's language. Interface controls follow the active interface language. Long text and source addresses wrap instead of widening the page.

## Layout

The general page shell is centered and up to 1120px wide, with narrower gutters on small screens. The report shell is up to 1180px wide with desktop gutters from the spacing tokens; its existing small-screen rule uses 22px side padding.

The listing view has a photo column and a narrower sticky facts card. Below 900px it becomes one column. Listing details stay in a closed disclosure below the main view.

The card row shows one full-width report card at a time, with a segmented position strip and previous/next controls. The row slides with the Embla carousel and responds to swipes, the mouse wheel and the arrow keys; the track only clips it. Next stays on the last card, disabled, so the controls keep their place. A finding card divides into a visual half and a text half. Below 800px the halves stack, and card navigation sits near the bottom of the viewport.

The evidence row wraps related actions into one band below the cards. Full report follows it as a closed disclosure. The review view replaces this whole report composition while the run is active.

The review has three equal step columns, each with its bar above its label, and four photo columns. On phones the steps stack into one column and the photo grid has two columns; at 560px and below the step labels get smaller. Review actions wrap as needed, and every grid track can shrink without pushing the page sideways.

## Elevation & Depth

Raised listing and report cards use the shared soft shadow. The light and dark themes each define their own shadow so depth remains visible without a bright border around every surface. Secondary panels are distinguished mainly by surface tone.

On wider screens the header sticks to the top on a translucent page-colored surface with blur. On phones, and on any screen 500px tall or less, it scrolls away with the page. Evidence and supplement dialogs use a backdrop and a raised surface; the diagnostics drawer remains a right-side panel with a sticky header.

**The Quiet Depth Rule.** Use the existing shared shadow for a raised surface. Inside a report section, use tone and spacing before adding another elevated container.

## Shapes

Main actions and the address field are pill-shaped. Standard cards, the larger report cards, photos and form fields use their named radii from the frontmatter. Equipment tags retain their smaller corners because they are compact, static facts.

Progress bars are narrow rounded tracks. Review photos keep a consistent 4:3 crop, and listing photos use the larger 16:10 slot. Images fill their visual region without changing its geometry as they load.

## Components

### Actions, fields and navigation

Primary buttons use the accent with contrasting text; secondary buttons use the secondary surface. Main actions and address fields are at least 48px tall. Smaller report actions are at least 44px tall and have a visible focus treatment. The page header contains the brand, the new-listing link and the ET/EN language switch.

Buttons lift slightly on hover and compress on press. Fields show an accent focus treatment and attention-colored invalid state. Text selection uses the accent and its contrasting text color.

### Card row

The cover combines the vehicle summary with the verdict, number of checks, status and confidence. Its background is the first listing photo when one exists; a tonal overlay keeps the text readable. Without a photo, it uses a plain secondary surface.

Finding cards show the first cited photo, or a large Phosphor area icon. Their text half contains the area, title, full explanation and an evidence control that opens the existing source dialog. The message card contains the composed seller request, its copy action and Seller replied. The checklist card holds inspection and workshop actions. Its checkboxes are drawn at 22px with 7px corners; a ticked box fills with the accent and shows a tick in the accent text color, and the whole row is the tap target. These action cards appear only when the review permits recommendations.

### Evidence row and Full report

The evidence row contains the supplement opener, the taustakontroll PDF upload, and retry and diagnostics controls when they apply. The supplement opens in a dialog. Offline reports keep the cards and Full report while hiding refresh, evidence controls that change the report, upload forms, retry and diagnostics.

Full report begins closed. It retains every finding, grouped by area, with next actions and evidence, other and cleared observations, photo review states, listing facts, sources and the methodology note. Nested disclosures keep the first read short without losing content.

### Review view

The review view starts with the vehicle title and the listing address as plain text. Three real-data bars represent Read listing, Review photos and Write review. The photo bar fills by reviewed selected photos; an active step without a measured fraction uses a half fill. Warning labels use the attention color.

The grid follows each supplied photo's state. Waiting and running tiles shimmer; reviewed tiles load their photos; unavailable and unselected tiles show a short label on the secondary surface. Unavailable tiles use the attention color. No grid is shown when there are no supplied photos.

Open the report stays disabled while queued, running or checking live progress. Complete, stopped and stale runs enable it, so saved findings stay reachable. The action sits beside one status line, with retry and diagnostics when applicable. Once opened, a complete review shows its reviewed-photo count above the cards; stopped and stale runs show their saved-findings message in the attention color.

A finished report opens directly to the cards. A new run after added information returns to the review view; a stale run resuming keeps the buyer on the cards. The old folding journal is gone.

### Motion and accessibility

Bar fills ease into position, waiting photos shimmer and the newly available Open the report button has one short entrance. Live work has a small spinner. Under `prefers-reduced-motion`, shimmer, bar transitions, spinner and button motion stop. These effects describe state; they never delay access to saved findings.

**The Reachable Result Rule.** A stopped or stale run must leave the report available. A disabled button communicates ongoing work, never a permanent dead end.

## Do's and Don'ts

### Do:

- Do use the shared role tokens in both themes.
- Do keep every saved finding and its evidence reachable.
- Do use real listing photos and Phosphor icons for missing visuals.
- Do preserve report-language attributes while translating interface strings in both message files.
- Do keep actions at least 44px tall with visible keyboard focus.
- Do stop review motion when reduced motion is requested.

### Don't:

- Don't reintroduce the folding activity journal.
- Don't load a waiting or unavailable photo in the review grid.
- Don't enable Open the report during queued, running or checking progress.
- Don't leave stopped or stale reviews behind a disabled report button.
- Don't use a score, a decorative metric or a fabricated claim in place of evidence.
- Don't clip long findings or hide observations to make the card row fit.

## Phone layout

Approved on 2026-10-14: 1A, 2A, 3A, 4B, 5A in `demos/redesign/phone/`. One shared breakpoint, `max-width: 639px`, limits these changes to phones. Wider layouts keep their existing geometry.

The header keeps the logo mark, language switch and an icon button for New listing, and scrolls away instead of sticking. The start page stacks its text above a full-width address bar with the submit button inside. Listing photos use native horizontal scrolling that snaps one photo at a time, with a current-photo count.

Listing and review actions use one fixed bottom-bar container with safe-area padding and reserved space beneath the page content. The diagnostics drawer covers the phone screen.

Report cards fill the available screen height (100svh minus 220px, at least 260px) and scroll internally when long. Their row slides with Embla, as on wider screens. Back, the dots and Next share one row in page flow below the cards, with the dots between the two buttons, as approved in option 4B; report navigation is not fixed. Next uses its short label on phones. The message copy action stays near the bottom of its card, checklist targets are at least 44px, and evidence and Full report stack in one column.

Phone scrollbar tracks are hidden without disabling scrolling, as requested on 2026-10-14. The page, long cards, galleries and sheets retain native scrolling. Wider layouts retain their existing scrollbars.
