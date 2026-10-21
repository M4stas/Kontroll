# Redesign design

Approved on 2026-10-10 after three rounds of demos, and revised on 2026-10-11 for the listing page and the review step. This file records what the user approved and the decisions that turn the demo into the real app. The [redesign plan](../archive/redesign/plans/2026-10-10-redesign.md) implements it.

## Reference demo

The approved demo lives in `demos/redesign/final/`. Serve it with:

```bash
python3 -m http.server 4317 --directory demos/redesign/final
```

- `index.html` holds the start page (`#start`) and the listing page (`#capture`, still labelled "Capture" in the demo).
- `review.html` holds the review step: the progress bars, the photo grid and the "Open the report" button.
- `report.html` holds the report: a row of cards with a verdict cover, one card per finding, a seller message card and a viewing checklist card.
- `style.css` and `walk.css` hold the tokens and the card row styles. `walk.js` holds the card row behavior.

The demo uses a synthetic Passat listing and Wikimedia photos. None of that content ships.

## Decisions

These came from the user on 2026-10-10 and override the demo where they differ.

1. Finding cards show only the finding: what was found and where it came from. Questions for the seller appear only on the message card, and checks only on the checklist card. The demo's "ask" box on each finding card does not ship.
2. Everything the cards do not show goes into a closed "Full report" section below the cards. Build it as a component that takes only the report and the locale, so it can later move to its own page without a rewrite.
3. The app follows the device's light or dark setting. There is no theme switch.
4. The start page ships without the hero photo. The front page design is still in progress, so only the hero text and the address bar ship. The demo's "Every point shows where it came from" section waits for that design.
5. Phone layouts come later, in their own checkpoint, after the desktop design is in place. Until then every page must stay usable at 390px wide: no sideways scrolling and every control reachable.

These came from the user on 2026-10-11 and replace the first version of the listing page and the report progress screen.

6. The listing page is a quick check before the report: "is this the right car?" It has no progress steps. The three-bar progress animation from the demo's first capture page belongs to the review, not to reading the listing.
7. Reading the listing shows a scan line over the photo slot and pulsing placeholders. When the details arrive they fade in. The capture contract only fills `listing` when the job is `completed`, so everything arrives in one poll and fades in together, with small row delays. Partial data during the capture is future extraction work.
8. The registration number and VIN come from the captcha work, which is not built yet. Each one pulses until it arrives, then fades in. "Open inspection report" waits for both, or for each to fail. One rule in `report-gate.ts` decides this, so the button can later open before they arrive. Until the extraction service reports these fields, their rows are hidden and the button opens as soon as the details are ready.
9. The review is its own step before the report. The report cards open only when the user presses "Open the report" after the review finishes. A report that is already finished when it is opened goes straight to the cards.

These phone decisions were approved on 2026-10-14 after the checkpoint 6 demos (1A, 2A, 3A, 4B, 5A). No hand edits were supplied.

10. Listing photos use a full-width native swipe gallery with a current-photo count.
11. The listing report button and its status line sit in a fixed bottom bar on phones. Review actions use the same safe-area-aware bar, with space reserved so content remains reachable.
12. Each report card fills the available phone screen height. Long cards scroll vertically inside themselves. On 2026-10-16 the user approved moving the row from native horizontal scrolling to Embla, which slides it with a transform: a native horizontal scroller holding vertically scrolling cards stuttered on the user's Android phone, and the Embla test page did not. Each swipe moves one card; a desktop trackpad swipe works through Embla's wheel-gestures plugin.
13. Back, the progress dots and Next sit in page flow below the report cards, following option 4B. They do not use a fixed bottom bar. This overrides checkpoint 6 plan references to fixed report navigation and the instruction that Back and Next always stay on screen.
14. The phone header shows the logo mark, ET/EN and an icon button for New listing. Phone rules apply only at max-width 639px; tablet and desktop remain unchanged.

15. On 2026-10-14 the user also requested hidden scrollbar tracks throughout the phone UI. Scrolling stays enabled for the page, galleries, cards and sheets. This applies only through 639px.

## Visual system

One sans family, one accent, soft surfaces. Values copied from the demo's `style.css`.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#f4f4f2` | `#0f1012` |
| `--surface` | `#ffffff` | `#17181b` |
| `--surface-2` | `#ebebe8` | `#202226` |
| `--text` | `#17181a` | `#ecedef` |
| `--text-2` | `#5b5e63` | `#a2a6ad` |
| `--line` | `rgb(23 24 26 / 10%)` | `rgb(236 237 239 / 10%)` |
| `--accent` | `#3050d0` | `#7d95ff` |
| `--accent-text` | `#ffffff` | `#0f1012` |
| `--accent-soft` | `rgb(48 80 208 / 9%)` | `rgb(125 149 255 / 12%)` |
| `--attention` | `#9a5b0c` | `#e8b878` |
| `--shadow` | `0 1px 2px rgb(30 34 60 / 6%), 0 12px 32px -12px rgb(30 34 60 / 18%)` | `0 1px 2px rgb(0 0 0 / 40%), 0 12px 32px -12px rgb(0 0 0 / 60%)` |

- Finished states, such as done steps and reviewed photos, use `--accent`. There is no separate success color.
- `--attention` is not in the demo. The app needs one color for errors, failed captures and stopped reviews, and the demo had no such states. Use it for nothing else.
- Type is Geist for text and Geist Mono for numbers that line up, such as mileage and counts. Load both with `next/font/google`, subsets `latin` and `latin-ext`, because Estonian uses `š` and `ž`.
- Corners: controls and inputs are fully round (pills), cards 20px, the report cards 28px, photos 14px.
- Motion: ease-out `cubic-bezier(0.16, 1, 0.3, 1)` for movement, spring `cubic-bezier(0.34, 1.3, 0.64, 1)` for button press. Every animation stops under `prefers-reduced-motion`.
- The header has the demo's logo mark: a rounded accent square with a check. The user approved it as part of the demo.

## Surfaces

### Start page (`/[locale]`)

The demo hero without the photo: the existing title, intro and note strings, and one pill-shaped address bar with the submit button inside it. The manual-entry toggle stays below. Copy is unchanged.

### Listing page (`/[locale]/a/[jobId]`)

The demo's `#capture` tab. Two columns at desktop width, stacked below 900px.

- Left column: the first listing photo large (16:10), then a row of four thumbnails and a "+N photos" tile. Pressing a thumbnail shows it in the large slot. Pressing the large photo opens it in a new tab, as today. "+N photos" opens "All listing details" at its photo grid.
- Right column: a card that stays in view while the page scrolls.
  - Title, then price, mileage and year in Geist Mono.
  - A short line with fuel, gearbox, power and body type, for the values the listing has.
  - The source link and the captured time.
  - Registration number and VIN rows, each pulsing until it arrives (decision 8).
  - "Open inspection report", then one status line under it, then "Continue manually".
- Below both columns: a closed "All listing details" section.

**While the listing is read**: the photo slot shows the scan line, the thumbnails and text lines pulse, and the status line reads the existing status title with the waiting time. Nothing else is shown.

**Failed capture**: the two columns are replaced by the failure message in the attention color, the source address, "Submit this listing again" and "Continue manually". No empty facts are shown.

**Where the data goes.** Everything the old page showed stays on the page:

| Data | Place |
| --- | --- |
| Title, price, mileage, year | Card head |
| Fuel, gearbox, power, body type | Card, one line under the figures |
| Make, model, first registration, drivetrain, colour, listing ID | "All listing details", Vehicle details |
| Source link, captured time | Card, under the figures |
| Registration number, VIN | Card rows (decision 8) |
| Photos | Large photo and thumbnails; every photo in "All listing details" |
| Description, seller, equipment, technical details, other details | "All listing details", one group each |
| Auto24 notes (capture warnings) | Attention line in the card, "N notes from Auto24", linking to the first group of "All listing details" |
| Status title, waiting time, last successful check | Status line under the button. The last check shows as a tooltip and in the accessible text |
| "Taking longer than usual", connection interrupted | Status line, replacing the waiting time |
| Checking paused | Status line with the "Check again" button |
| Manual entry | "Continue manually" under the status line, opening the existing form below the card |
| Access and service errors | The existing access fallback page, restyled with the tokens |

### Report (`/[locale]/r/[publicId]`)

The report has two views at the same address.

**Review view** (demo `review.html`), while the review runs and until the user opens the report:

1. Vehicle title and the listing address.
2. Three bars with labels: read listing, review photos, write review. Each bar follows real data. Read listing follows `review.text`. Review photos fills by `images.complete / images.selected`, with an "x of y" count. Write review follows `review.final`. A step with no measurable fraction shows the demo's half fill while it is active.
3. The photo grid. Each tile follows `images.items`: waiting tiles shimmer, reviewed photos appear in full, unavailable and skipped photos say so.
4. "Open the report", disabled until the review is complete, with one status line beside it. The status line uses the existing activity copy: queued, running, stale and stopped. Stale and stopped use the attention color.
5. Retry and the Live diagnostics button sit beside the status line when they apply, as in the existing activity journal.

This replaces the activity journal's look and keeps its state logic in `activity-state.ts`.

**Report view**, after "Open the report" or when the report is already complete on arrival (decision 9):

1. A "Review complete" line with the photo count.
2. The card row:
   - A cover with the vehicle line, the verdict (or "Checking the listing" while pending), how many things to check, the status and the confidence. The background is the first listing photo, or a plain surface when there is none.
   - One card per primary finding, chosen by the existing selection rules in `report-view.tsx`. The left half shows the finding's first photo, or a large icon for its area. The right half shows the area label, the title, the explanation and a source line that opens the existing evidence dialog.
   - A message card when the review is complete and seller actions exist. It holds the existing composed seller message, the copy button and a "Seller replied" button.
   - A checklist card when the review is complete and inspection or workshop actions exist. Ticks live in page memory only. Saving them waits for the offline record format.
3. A row with "Seller replied or new photos?" and the taustakontroll PDF upload. Retry and the Live diagnostics button sit here too when they apply.
4. The closed "Full report" section: every finding grouped by area with its next check and evidence, other and cleared observations, per-photo review states, listing facts, sources and the methodology note.

Findings have no structured numbers, so the demo's mileage comparison graphic (318 950 against 312 400) does not ship. A card with no photo uses an area icon.

## Product rules the redesign keeps

- Every finding in the report stays visible somewhere: on a card or in the full report.
- Report-authored text keeps `lang` set to the report's locale.
- Seller message and checklist appear only when the review is complete, as today.
- The `offline` prop on `ReportView` keeps hiding refresh, diagnostics and every upload form, and now also retry. The offline checkpoints rely on it.
- Estonian and English ship together for every new string.
