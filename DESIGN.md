---
name: Kontroll
description: Inspect a used-car listing before you go see it.
colors:
  ink-navy: "#141d29"
  blue-gray: "#202d3d"
  off-white: "#edf1f5"
  steel: "#abb9c9"
  amber: "#e8b878"
  pale-blue: "#94bce8"
  success-green: "#8ad5b4"
  border: "rgb(171 185 201 / 28%)"
  quiet-border: "rgb(171 185 201 / 16%)"
  report-ink: "#17202c"
  report-rule: "#39495f"
  report-link-blue: "#aac9ff"
  report-body-text: "#e1e5ea"
  report-muted-text: "#c4ccd5"
  report-button-stroke: "#6d83a0"
  report-dot-fill: "#222f41"
typography:
  display:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "clamp(36px, 6vw, 68px)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "clamp(28px, 4.3vw, 46px)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  verdict:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  report-body:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  lead:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
  caption:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  hairline: "2px"
  sm: "3px"
  md: "4px"
  full: "50%"
spacing:
  xs: "6px"
  sm: "10px"
  md: "18px"
  lg: "24px"
  xl: "34px"
  page-x: "28px"
  page-x-mobile: "16px"
components:
  button-primary:
    backgroundColor: "{colors.pale-blue}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.md}"
    padding: "0 18px"
    height: "46px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.off-white}"
    rounded: "{rounded.md}"
    padding: "0 18px"
    height: "46px"
  button-evidence:
    backgroundColor: "transparent"
    textColor: "{colors.report-link-blue}"
    rounded: "{rounded.sm}"
    padding: "13px 23px"
    height: "48px"
  input-url:
    backgroundColor: "{colors.blue-gray}"
    textColor: "{colors.off-white}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
    height: "48px"
  status-panel:
    backgroundColor: "{colors.blue-gray}"
    textColor: "{colors.off-white}"
    padding: "17px 20px"
  notice-panel:
    backgroundColor: "{colors.blue-gray}"
    textColor: "{colors.off-white}"
    padding: "18px 20px"
  equipment-chip:
    backgroundColor: "transparent"
    textColor: "{colors.off-white}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
---

# Design System: Kontroll

## Overview

**Creative North Star: "The Inspection Sheet"**

Kontroll reads like a calm, factual inspection sheet that a buyer takes to a viewing. It is dark, quiet and text-led. Hierarchy comes from type size, a few rules and one accent edge, not from cards, shadows or illustration. The September prototype spec chose this "dark inspection-sheet" direction on purpose and rejected a generic dashboard, decorative car art, repeated KPI cards, gradients, glass effects and an arbitrary score ([prototype spec](docs/superpowers/archive/2026-09-12/2026-09-12-used-car-analysis-prototype-design.md#visual-system)).

The interface has two densities. The submission page and listing dashboard are compact working surfaces with 12–14px supporting text, fact grids and hairline rules. The written report is a reading surface with larger type (20px body, 48px verdict), a slightly lighter base and its own set of text colors. Both are recorded here as they exist today; neither has been declared the standard.

Colour carries meaning. Pale blue means action, focus and "in progress". Amber means "open check", "needs attention" or "stopped". Green means "done". Everything else is navy, gray and off-white.

**Key Characteristics:**
- Dark only (`color-scheme: dark`); no light theme exists.
- One system font stack (Arial, Helvetica) with tight negative tracking on headings.
- Flat surfaces separated by 1px rules and a 2px left accent edge.
- Small radii (2–4px) on controls; circles only for status dots.
- 44px minimum touch targets on every link and control.
- Motion only for live status: spinners and the activity journal's fold-away.

## Colors

A cool navy-and-steel night palette with two signal colors and a success green.

### Primary
- **Pale Blue** (`pale-blue`): primary buttons, focus outlines (3px, 3px offset), text selection, links in the dashboard, the left edge of the submission and running status panels, and running spinners.

### Secondary
- **Muted Amber** (`amber`): open checks and anything that needs the buyer's attention: queued, failed and lost-connection status edges, form errors, the slow-progress note, stale or stopped activity steps, and the notice and access panel edges. It also stands in for "destructive"; there is no red.

### Tertiary
- **Success Green** (`success-green`): finished states, such as completed activity steps and their connecting line, the compact "review complete" line, and the completed photo state icon. The diagnostics drawer currently uses a second green (`#86efac`) for complete and reused states; merge it into this token.

### Neutral
- **Ink Navy** (`ink-navy`): page background everywhere except the report.
- **Blue-Gray** (`blue-gray`): raised surfaces, such as status panels, notice panels, inputs and photo frames. The submission panel uses it at 65% opacity.
- **Off-White** (`off-white`): primary text.
- **Steel** (`steel`): secondary text, labels, metadata and the secondary button stroke. Inputs use it at 52% for their border and 67% for placeholders.
- **Border** (`border`, steel at 28%): header rule and section top rule.
- **Quiet Border** (`quiet-border`, steel at 16%): fact grid lines, detail rows, equipment chips and photo frames.

### Report reading surface (recorded as-is)
The written report overrides the base and uses its own literal values instead of the tokens above:
- **Report Ink** (`report-ink`): replaces Ink Navy inside `.report-shell` and on its `body`.
- **Report Rule** (`report-rule`): header divider.
- **Report Link Blue** (`report-link-blue`): the evidence button text and running photo state. A brighter blue than Pale Blue.
- **Report Body Text** (`report-body-text`): review paragraphs.
- **Report Muted Text** (`report-muted-text`): vehicle summary and status line. Nearby text also uses `#ccd2d9` (language links), `#bcc6d0` (evidence caption) and `#aebac7` (footer).
- **Report Button Stroke** (`report-button-stroke`): the evidence button border.
- **Report Dot Fill** (`report-dot-fill`): background of photo state circles.
- The activity journal draws pending dots and dashed lines in `#c9d2d0`.

### Named Rules
**The Signal Rule.** Pale blue, amber and green each mean one thing: act or in progress, check this, done. Don't use them for decoration.

**The No-Red Rule.** Problems show in amber. The palette has no red, and errors should not read as alarms.

## Typography

**Body Font:** Arial (with Helvetica, sans-serif)

**Character:** One plain, highly legible system sans. Headings get personality from heavy negative tracking (-0.02em to -0.045em) and tight line height, not from a second family.

### Hierarchy
- **Display** (600, `clamp(36px, 6vw, 68px)`, 1.04): the home page headline only; 39px below 560px.
- **Headline** (600, `clamp(28px, 4.3vw, 46px)`, 1.08): the listing dashboard title.
- **Verdict** (400, 48px, 1.15): the report verdict; 36px below 640px. Regular weight, not bold, unlike the other headings.
- **Report brand** (700, 30px; 26px on mobile): "Kontroll" in the report header. Elsewhere the brand is 15px bold.
- **Title** (600, 19px, -0.02em): listing section headings. Notice and access panel headings are 20px.
- **Report body** (400, 20px, 1.65; 17px on mobile): written review paragraphs. Review title is 23px regular.
- **Lead** (400, 17px, 1.65, steel): intro copy on the home page, max width 620px.
- **Body** (400, 14px, 1.7): listing description and panel copy, max width 880px.
- **Label** (700, 13–14px): field labels, sub-section headings in steel, source links.
- **Caption** (400, 12px): fact labels, status metadata, chips, language switch (bold).

### Named Rules
**The One Family Rule.** Arial carries everything. Use size, weight and tracking for hierarchy; don't add a display font.

## Layout

- **Container:** `.page-shell` is up to 1120px wide, centred, with 20px top, 28px side and 64px bottom padding. The report shell is up to 1180px with 44px/40px/72px padding.
- **Reading widths:** home content 800px, lead copy 620px, description 880px, written review 1000px, report footer 800px, activity messages 65ch.
- **Header:** brand on the left, actions and the ET/EN switch on the right, 48px minimum height, 1px bottom rule. The report header adds 65px space below it (42px on mobile).
- **Grids:** the fact grid is 4 columns, 3 below 760px and 2 below 560px, drawn as a ruled table with shared borders. Detail groups are 2 columns, 1 below 560px. The photo grid is 4 columns with 10px gaps, 2 columns with 8px below 560px. Photos are 4:3 and cropped to fill.
- **Breakpoints:** 760px (tighter page padding, status panel stacks, dashboard heading stacks), 640px (report and diagnostics drawer), 560px (full-width buttons, stacked form controls, 16px page gutter).
- **Rhythm:** sections are separated by 24px vertical padding and a quiet rule. The September spec planned an asymmetric report body on desktop with a strict single column below 768px; the current report is a single reading column at all widths.

## Elevation & Depth

The system is flat. No component uses `box-shadow`, and the shadcn primitives override theirs with `shadow-none`. Depth comes from tone (navy base, blue-gray raised surfaces), 1px rules, and a 2px left accent edge on panels that need attention. The only layered element is the diagnostics drawer: a full-height dialog on the right with a 55% black backdrop and a steel left border.

### Named Rules
**The Edge, Not Shadow Rule.** Raise a panel with a blue-gray fill and a 2px left edge in its signal colour. Don't add shadows or glass.

## Shapes

Corners are nearly square. Controls use 4px, the evidence button and equipment chips 3px, skeleton placeholders 2px. Status indicators, activity dots and photo state icons are full circles. Panels have no radius at all; only their left edge is marked. The spec allows 3–5px for controls and real raised surfaces.

The shadcn primitives in `src/components/ui` default to `rounded-lg` (8px). Where they appear in forms, call sites override them with `rounded-sm`.

## Components

### Buttons
- **Shape:** 4px radius, 46px minimum height, 0 18px padding, 14px bold text.
- **Primary:** pale blue fill, ink navy text. When disabled it shows a `wait` cursor at 72% opacity.
- **Secondary:** transparent with a steel border and off-white text.
- **Evidence (report):** transparent with a `report-button-stroke` border, report link blue text, 18px, 48px tall, 3px radius.
- **Mobile:** primary and secondary buttons go full width below 560px.
- **Focus:** 3px pale blue outline at 3px offset, from the global focus rule.

### Inputs / Fields
- **URL input:** blue-gray fill, 1px steel border at 52%, 4px radius, 48px tall. Placeholder in steel at 67%.
- **Textareas (supplements, manual entry):** ink navy at 45% fill, steel border at 35–45%, 4px radius, no shadow, 12px padding.
- **Labels and notes:** 14px bold label above, 13px steel note below. Errors use the same size in amber.

### Status panel
A blue-gray band with a 2px left edge: pale blue while running, amber when queued, failed or disconnected. A 14px ring spinner sits beside a 17px bold title and a 14px steel description. Metadata sits on the right at 12px and moves under the text below 760px.

### Notice and access panels
Blue-gray with a 2px amber left edge, 20px heading, 14px steel copy. The access panel is centred, up to 700px wide, with 64px top margin.

### Fact grid
A ruled table of vehicle facts. 12px steel labels over 14px semibold values, 76px minimum cell height. Loading cells show a 12px tall, 2px radius placeholder bar in steel at 15%.

### Equipment chips
Inline tags with a quiet border, 3px radius, 12px text and 5px 8px padding. They are static, not interactive.

### Activity journal
The review progress list. Each step has a 32px circle and a label. A vertical line joins the steps: dashed `#c9d2d0` while pending, solid green when done. The current step turns pale blue while running and amber when stale or stopped. When all steps finish, the list folds into a single "Review complete" line over 2.1s. With reduced motion, the fold and spinner stop.

### Diagnostics drawer
A right-side dialog, up to 34rem wide (full width below 640px), ink navy, with a sticky header and 14px body. Cards are separated by top rules. State text is green for complete and reused, and amber for running, retrying and stale.

### Navigation
Text only. The brand is a 15px bold link. The "new listing" link is 13px steel. The ET/EN switch uses 44px square 12px bold links in steel, with the current language in off-white (`aria-current="page"`).

## Do's and Don'ts

### Do:
- **Do** keep every link and control at least 44px tall.
- **Do** use the 3px pale blue focus outline at 3px offset on all interactive elements.
- **Do** mark panel state with a 2px left edge: pale blue for active, amber for attention.
- **Do** set every string in both Estonian and English and check that layouts hold for the longer Estonian text.
- **Do** honour `prefers-reduced-motion`; the global rule already cuts animations to 0.01ms.
- **Do** use `success-green` for done states, and replace `#86efac` in the diagnostics drawer with it.

### Don't:
- **Don't** build a generic dashboard, repeat KPI cards or show an arbitrary score.
- **Don't** add decorative car illustrations, gradients or glass effects.
- **Don't** use box shadows; depth comes from tone and rules.
- **Don't** use red; problems are amber.
- **Don't** use radii above 5px on controls or surfaces.
- **Don't** animate anything that isn't live status or direct feedback.
