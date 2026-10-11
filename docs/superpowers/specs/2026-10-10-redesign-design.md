# Redesign design

Approved on 2026-10-10 after three rounds of demos. This file records what the user approved and the decisions that turn the demo into the real app. The [redesign plan](../plans/2026-10-10-redesign.md) implements it.

## Reference demo

The approved demo lives in `demos/redesign/final/`. Serve it with:

```bash
python3 -m http.server 4317 --directory demos/redesign/final
```

- `index.html` holds the start page (`#start`) and the capture page (`#capture`).
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

The demo's capture page, mapped onto what this page really does, which is capture listing details:

- Left column: vehicle title, captured time and source link, a three-step progress bar for the capture job, the photo grid (grey placeholders until the details arrive), then description, seller, equipment and technical details.
- Right column: a card that stays in view with the key facts and the existing report actions.
- The three steps are "Request received", "Reading the listing" and "Details ready". They map from the job status: `queued`, `running`, `completed`, and `failed` marks the reading step with `--attention`.

### Report (`/[locale]/r/[publicId]`)

From top to bottom:

1. While the review runs: a progress screen with the vehicle name, three progress segments (read listing, review photos, write review) and the photo grid, where each photo shows its review state. It folds into a "Review complete" line when the review finishes. This replaces the activity journal's look and keeps its state logic.
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
