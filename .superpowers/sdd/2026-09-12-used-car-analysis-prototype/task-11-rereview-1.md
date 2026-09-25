# Task 11 re-review — fix round 1

### Finding Verdicts

1. **NOT ADDRESSED — Important** — `src/features/report/report-view.tsx:44,93-110,135-137`; `src/features/report/seller-message.tsx:27-38,61-66`; `src/features/report/viewing-checklist.tsx:42-45`. The route-localized article and UI labels remain under `lang={locale}`, and finding fields plus checklist action fields now receive `report.locale`. However, the seller preview still combines route-localized headings from `t("seller.questions")` / `t("seller.requests")` with report-authored action instructions in one textarea, then assigns `lang={contentLocale}` to the entire value. After ET→EN, this correctly labels the persisted instructions as ET but incorrectly relabels the EN section headings as ET. The required per-content scoping is therefore incomplete; the mixed-language mislabel has moved inside the seller preview instead of being eliminated.

2. **ADDRESSED — Important, under controller ruling** — `src/features/report/report-view.tsx:110`; `src/features/report/evidence-disclosure.tsx:13-18,40-45`; `task-11-report.md:139-146,177`. `report.locale` is passed as the evidence content locale and applied only to claim/applicability text; route-translated disclosure labels remain under the article's route locale. No domain, persistence, snapshot, or provider field was added. The appended report explicitly records that exact source language is unavailable upstream and requires a future contract change. Switching the UI locale therefore no longer changes the persisted locale signal used for evidence text.

3. **ADDRESSED — Important** — `src/features/report/seller-message.tsx:15-18,38,42-52,68-78`; `messages/en.json:96`; `messages/et.json:96`. Missing Clipboard API support and rejected writes are contained and produce localized visible retry guidance. The guidance is an ordinary paragraph, not another polite live region. Copy outcome is keyed to the exact composed message, so copied and failed presentation disappear when the message changes.

4. **ADDRESSED — Minor** — `src/features/report/report-view.tsx:60-70`. The stable fact key now includes the existing `sourceId` together with the fact key and value; no domain expansion was introduced.

### New Breakage in the Fix Diff

**Important — `src/features/report/seller-message.tsx:27-38,61-66`:** The newly added textarea-level `lang={contentLocale}` covers both report-authored instructions and route-localized section headings. In a mixed route/report locale, assistive technology receives incorrect language metadata for one part of the value. Render the two language scopes separately, or ensure every string inside the single-language control is generated in the same locale.

### Out-of-Scope Observations

None.

### Verdict

Finding 1 remains open due to the seller-preview mixed-language scope. Findings 2–4 are addressed. The fix diff introduces one Important language-metadata regression in that same seller-preview path; there is no new Critical breakage identified.

Controller-provided verification on head `39e1374` was noted: local-Supabase Playwright 1/1, focused units 38/38, typecheck, lint, and diff check passed. Per review instructions, these suites were not rerun.
