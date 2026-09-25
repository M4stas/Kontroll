### Task 12: Accept seller answers, documents, and additional images

**Files:**
- Create: `src/features/supplements/add-submission.ts`
- Create: `src/features/supplements/supplement-form.tsx`
- Create: `src/app/api/analyses/[publicId]/submissions/route.ts`
- Create: `tests/unit/supplements/add-submission.test.ts`
- Create: `tests/integration/submissions.test.ts`
- Modify: `src/analysis/affected-stages.ts`
- Modify: `src/features/report/report-view.tsx`
- Modify: `messages/et.json`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: private storage, analysis access, and `affectedStages`.
- Produces: `addSubmission(input, deps): Promise<{ runId: string; queuedStages: AnalysisStage[] }>`.

- [ ] **Step 1: Write failing incremental-rerun tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { addSubmission } from "@/features/supplements/add-submission";

describe("addSubmission", () => {
  it("queues image enrichment and assembly without recapturing the listing", async () => {
    const jobs = { enqueueMany: vi.fn() };
    const result = await addSubmission({ kind: "image", analysisId: "analysis-1", storageKey: "private/photo.webp" } as never, { jobs } as never);
    expect(result.queuedStages).toEqual(["enrich", "assemble_report"]);
    expect(result.queuedStages).not.toContain("capture_listing");
  });
});
```

- [ ] **Step 2: Run supplement tests and verify failure**

Run: `npm run test -- tests/unit/supplements`

Expected: FAIL because the supplement feature does not exist.

- [ ] **Step 3: Implement upload and answer validation**

Require valid analysis access. Accept seller answer text up to 10,000 characters and at most eight files per request. Recheck MIME type from bytes, generate a random storage key, and never use the original file name as a path. Strip image EXIF metadata before persistence while preserving orientation.

- [ ] **Step 4: Implement affected-stage selection**

- Seller answer: `baseline_checks`, `enrich`, `assemble_report`.
- Image or screenshot: `enrich`, `assemble_report`.
- Maintenance document: `baseline_checks`, `enrich`, `assemble_report`.
- VIN or plate correction: `normalize_identity`, `baseline_checks`, `research`, `enrich`, `assemble_report`.

Create a new `analysis_run` for every accepted submission group. Use a client-provided UUID idempotency key to prevent duplicate uploads and jobs.

- [ ] **Step 5: Build supplement UI**

Place one "Add seller information" action after the existing report. Explain that supplied information is initially unverified. Show uploaded file type and processing state without exposing storage URLs.

- [ ] **Step 6: Verify upload privacy and reruns**

Run:

```bash
npm run test -- tests/unit/supplements
npm run test:integration -- tests/integration/submissions.test.ts
npm run test:e2e -- tests/e2e/analysis.spec.ts
```

Expected: unauthorized upload is 401, duplicate idempotency key creates one run, image upload queues only affected stages, and the updated verdict appears in the same report.

- [ ] **Step 7: Commit**

```bash
git add src/features/supplements src/app/api/analyses src/analysis/affected-stages.ts src/features/report/report-view.tsx messages tests/unit/supplements tests/integration/submissions.test.ts tests/e2e/analysis.spec.ts
git commit -m "feat(evidence): update reports from seller input"
```

---

