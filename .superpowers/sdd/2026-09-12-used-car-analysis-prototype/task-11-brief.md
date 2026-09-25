### Task 11: Build the approved report interface

**Files:**
- Create: `src/app/[locale]/a/[publicId]/page.tsx`
- Create: `src/features/report/report-view.tsx`
- Create: `src/features/report/report-refresh.tsx`
- Create: `src/features/report/evidence-disclosure.tsx`
- Create: `src/features/report/seller-message.tsx`
- Create: `src/features/report/viewing-checklist.tsx`
- Create: `tests/fixtures/sample-report.ts`
- Create: `tests/unit/report/report-view.test.tsx`
- Create: `tests/e2e/analysis.spec.ts`
- Modify: `src/app/globals.css`
- Modify: `messages/et.json`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `AnalysisReport` and token-scoped report API from Task 10.
- Produces: verdict-first bilingual report, progressive refresh, evidence disclosures, copy action, and checklist interaction.

- [ ] **Step 1: Write failing report hierarchy tests**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportView } from "@/features/report/report-view";
import { sampleReport } from "../../fixtures/sample-report";

describe("ReportView", () => {
  it("renders verdict before findings and labels seller claims", () => {
    render(<ReportView report={sampleReport} locale="en" />);
    const verdict = screen.getByRole("heading", { name: /worth a viewing/i });
    const findings = screen.getByRole("heading", { name: /still needs checking/i });
    expect(verdict.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/seller claim.*unverified/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run component tests and verify failure**

Run: `npm run test -- tests/unit/report`

Expected: FAIL because the report components do not exist.

- [ ] **Step 3: Implement the report composition**

Match the approved inspection-sheet mockup:

- deep ink page and blue-gray raised surfaces;
- verdict as the largest element;
- compact vehicle facts beneath the verdict;
- amber inspection rail only for unresolved checks;
- evidence inside accessible disclosures;
- seller request section with one copy button;
- separate mobile-first viewing checklist;
- source status with plain labels;
- no car illustration, gradient, glass effect, score ring, equal KPI cards, or excessive rounding.

Use shadcn primitives for button, accordion, checkbox, input, textarea, and separator but replace their default tokens. Use Phosphor icons from one family only.

- [ ] **Step 4: Implement progressive refresh**

While status is not `complete`, refresh server-rendered report data every three seconds. Stop on complete, unrecoverable failure, tab hidden for more than 30 seconds, or component unmount. Announce material stage changes through one polite `aria-live` region.

- [ ] **Step 5: Implement ET/EN and buyer actions**

All interface copy comes from matching translation keys. Source excerpts retain original language. Copy action copies seller questions and image requests in the active locale. Checklist controls use 44 px minimum touch targets.

- [ ] **Step 6: Add initial Playwright report checks**

Test:

1. Submit a seeded Auto24 URL.
2. Exchange fragment access and open the report.
3. See verdict before findings.
4. Expand evidence.
5. Switch ET to EN.
6. Check one viewing item.
7. Verify the 390 x 844 viewport has no horizontal overflow.

- [ ] **Step 7: Run visual feature verification**

Run:

```bash
npm run test -- tests/unit/report
npm run test:e2e -- tests/e2e/analysis.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/app src/features/report src/app/globals.css messages tests/unit/report tests/e2e/analysis.spec.ts
git commit -m "feat(ui): add verdict-first inspection report"
```

---

