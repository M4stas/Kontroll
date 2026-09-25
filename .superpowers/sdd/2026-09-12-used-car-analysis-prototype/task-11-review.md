### Spec Compliance

Verdict: Not fully compliant. The implementation preserves the approved inspection-sheet direction and satisfies capability-cookie loading, polling stops, accessible disclosures, one seller-copy action, touch-sized checklist controls, and the required mobile journey. Locale switching, however, changes only translated chrome while report-authored content keeps the analysis locale and is then mislabeled with the route locale.

### Strengths

- `src/app/[locale]/a/[publicId]/page.tsx:18`: Every server report load starts from the public-ID-scoped capability cookie, and `loadReport` verifies it before repository access.
- `src/features/report/report-refresh.tsx:16`: Three-second refresh, complete/failed termination, hidden-over-30-seconds termination, cleanup, and one polite status region match the lifecycle requirement.
- `src/features/report/report-view.tsx:82`: Amber is confined to open findings; the layout remains verdict-first and avoids the prohibited dashboard/illustration treatments.
- `tests/e2e/analysis.spec.ts:185`: Only the seeded submission response is intercepted; the public-ID access request is not, and the verdict can render only after the real fragment exchange sets a valid cookie. The E2E therefore genuinely exercises access exchange and protected report loading.
- `tests/e2e/analysis.spec.ts:184`: The journey covers the requested 390x844 viewport, hierarchy, evidence disclosure, ET→EN switch, checklist interaction, and horizontal-overflow assertion.

### Issues

#### Critical

None.

#### Important

- `src/features/report/report-view.tsx:44`: The route locale is assigned to the entire article, but findings/actions remain the single-language strings associated with `report.locale` (`:90-95`, `seller-message.tsx:24-27`, `viewing-checklist.tsx:42-43`). After ET→EN the page is mixed-language and assistive technology pronounces unchanged Estonian report content as English. Provide locale-specific finding/action fields for the active locale, or scope those fields with `lang={report.locale}` until translated; keep source excerpts separately tagged with their actual source language.
- `src/features/report/evidence-disclosure.tsx:39`: Original-language excerpts have no language metadata, and `Evidence` carries no source-language field. Screen readers therefore use the surrounding UI language and can mispronounce the evidence. Add a BCP 47 language value to evidence and apply it with `lang` to the claim/applicability container.
- `src/features/report/seller-message.tsx:35`: Clipboard rejection or an unavailable Clipboard API escapes the click handler with no user-visible recovery, while `copied` also remains true if progressive refresh changes the message after a successful copy. Catch failures, expose localized retry feedback without adding another polite live region, and reset copy state whenever `message` changes.

#### Minor

- `src/features/report/report-view.tsx:63`: `${fact.key}-${fact.value}` is not unique when the same fact/value is supported by multiple sources, so React can reuse the wrong row during refresh. Use a stable fact ID, or include `sourceId` in the key and enforce uniqueness in the report contract.

### Assessment

Request changes for the three important issues above. Controller verification is otherwise strong: real local-Supabase E2E 1/1, focused units 31/31, and typecheck/lint/diff-check all pass. The existing Next middleware deprecation and FORCE_COLOR/NO_COLOR warnings are outside this diff and are not Task 11 blockers.
