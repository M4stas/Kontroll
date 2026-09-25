### Finding Verdicts

- **Resolved — exact manual-copy fallback.** `src/features/report/seller-message.tsx:96-106` renders the fallback only when `copyStatus === "failed"`; the read-only textarea uses `value={message}`, which is the exact composed payload, and `lang=""` avoids falsely assigning either language. `tests/unit/report/report-view.test.tsx:213-222` independently defines the expected combined payload and verifies both `writeText(attemptedMessage)` and an identical fallback value with an empty `lang` attribute.
- **Resolved — normal split preview and language scopes preserved.** The production hunk is additive after the existing single copy button; it does not alter the normal per-language preview controls (`src/features/report/seller-message.tsx:87-95`). The fallback appears only in the failed branch (`src/features/report/seller-message.tsx:96-106`).
- **Resolved — exactly one copy button.** The existing button remains the sole copy trigger at `src/features/report/seller-message.tsx:88-95`; the new fallback is a read-only textarea and introduces no second action.
- **Resolved — fallback clears when the message changes.** The fallback remains governed by the existing message-keyed `copyStatus`. The regression test rerenders with changed action instructions and verifies that both failure guidance and the fallback textbox disappear (`tests/unit/report/report-view.test.tsx:224-243`).

### New Breakage in the Fix Diff

None found. The fix is narrowly limited to localized fallback copy, one failure-only textarea, and focused regression assertions. It does not change clipboard composition, normal preview rendering, language-scoped preview content, or button behavior.

### Out-of-Scope Observations

- No out-of-scope defects identified from the supplied fix diff.
- Per review constraints, I did not rerun tests or inspect files outside the brief, report, and one supplied diff read. The controller-provided verification remains: real local-Supabase Playwright 1/1, focused units 39/39, and typecheck, lint, and diff check exit 0.

### Verdict

**PASS.** The remaining Important manual-copy finding is resolved, and the fix diff introduces no new breakage.
