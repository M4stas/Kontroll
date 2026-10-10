# Roadmap

Planned checkpoints that are not yet implemented. Each one needs the user's approval before work starts. Finished work lives in [archive](archive/README.md).

| Order | Checkpoint | Status | Source |
| --- | --- | --- | --- |
| 1 | Live diagnostics checkpoint 2: detailed capture timings | Planned, not approved | [plan](plans/2026-10-09-live-diagnostics.md#checkpoint-2-detailed-capture-timings) |
| 2 | Live diagnostics checkpoint 3: complete diagnostic workflow | Planned, not approved | [plan](plans/2026-10-09-live-diagnostics.md#checkpoint-3-complete-diagnostic-workflow) |
| 3 | Offline report saving | Needs a spec | This file |

The order is a suggestion. Offline report saving does not depend on live diagnostics.

## Live diagnostics checkpoints 2 and 3

The [design](specs/2026-10-09-live-diagnostics-design.md) and [plan](plans/2026-10-09-live-diagnostics.md) describe both checkpoints. Checkpoint 1 shipped in PR #14.

Checkpoint 2 adds timing storage and Auto24 capture instrumentation. A developer can then see which capture phase or photo caused a wait, including time spent before the report existed.

Checkpoint 3 adds PDF processing timings, earlier-run selection, previous and current final results, and a timing-only JSON export.

## Offline report saving

A buyer can open a saved private report at a viewing without a connection. `main` has no offline saving today. `README.md` and `docs/local-development.md` say so.

### Approach

Write the feature fresh. Use the branch `codex/used-car-prototype` only as reference. Its offline code is in commits `5962ce8`, `f86e2ad` and `2398ea9` under `src/features/offline/`, plus `public/sw.js` and `tests/unit/offline/`.

A review on 2026-10-10 found that adapting the prototype code would cost more than rewriting it:

- Its service worker matches `/(et|en)/a/<uuid>`. On `main`, `/a/` is the listing dashboard and reports live at `/r/`.
- A 401 or 403 response leaves the cached report in place, so revoked access still works offline.
- Saving one report clears every other saved report, and records carry no schema version.
- Only `/_next/static/` is cached, so photos and taustakontroll PDFs would be missing offline.
- The worker registers at scope `/` and serializes every static asset request.

Worth reading in the prototype: the ordered IndexedDB write queue and validation on read in `report-cache.ts`, the shell-only caching that keeps report data out of cached HTML, the race tests where a clear runs during a fetch, and the ET/EN `Report.offline` strings that PR #16 removed from `main`.

### Requirements for the spec

- Store each report under its own `publicId`.
- Version stored records and expire them.
- Delete the saved copy on any 401 or 403 response.
- Limit the service worker scope to `/(et|en)/r/`.
- Decide whether photos and taustakontroll PDFs are available offline. They need their own access-checked caching, because the image API returns `private, no-store`.
- Connect or remove the unused `offline` prop in `src/features/report/report-view.tsx`.

### Estimate

About 10 to 14 hours with photo and PDF caching, or 6 to 8 hours without them. Writing the spec takes about an hour.
