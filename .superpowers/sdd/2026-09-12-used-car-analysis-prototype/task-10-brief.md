### Task 10: Assemble and publish progressive reports

**Files:**
- Create: `src/analysis/pipeline.ts`
- Create: `src/analysis/assemble-report.ts`
- Create: `src/analysis/affected-stages.ts`
- Create: `src/features/report/load-report.ts`
- Create: `src/app/api/analyses/[publicId]/report/route.ts`
- Create: `tests/unit/analysis/assemble-report.test.ts`
- Create: `tests/unit/analysis/affected-stages.test.ts`
- Create: `tests/integration/progressive-report.test.ts`

**Interfaces:**
- Consumes: adapters, baseline checks, research cache, optional insights, and repositories.
- Produces: `runStage(context: StageContext): Promise<StageResult>`.
- Produces: `assembleReport(input: AssemblyInput): AnalysisReport`.
- Produces: `affectedStages(submission: Submission): AnalysisStage[]`.

- [ ] **Step 1: Write failing evidence and partial-report tests**

```ts
import { describe, expect, it } from "vitest";
import { assembleReport } from "@/analysis/assemble-report";

describe("assembleReport", () => {
  it("drops important findings that lack evidence", () => {
    const report = assembleReport({ findings: [{ severity: "important", evidenceIds: [] }], evidence: [] } as never);
    expect(report.findings).toHaveLength(0);
    expect(report.warnings).toContain("finding_without_evidence");
  });

  it("marks an unavailable registry as not checked", () => {
    const report = assembleReport({ findings: [], evidence: [], sourceStates: { transportAdministration: "unavailable" } } as never);
    expect(report.sources.transportAdministration.verification).toBe("not_checked");
  });
});
```

- [ ] **Step 2: Run analysis tests and verify failure**

Run: `npm run test -- tests/unit/analysis/assemble-report.test.ts tests/unit/analysis/affected-stages.test.ts`

Expected: FAIL because report assembly modules do not exist.

- [ ] **Step 3: Implement stage orchestration**

Each stage reads persisted outputs from its dependencies and writes one versioned result. `assemble_report` can run after required stages complete or become unavailable. Enrichment is never a required dependency.

Publish status transitions `queued` to `running` to `partial` to `complete`. Use `failed` only when no usable baseline can be produced.

- [ ] **Step 4: Implement evidence-safe assembly**

Reject critical and important findings without valid evidence IDs. Deduplicate actions by normalized intent. Calculate confidence and verdict only with Task 2 policies. Preserve source states and unresolved identity fields in the result.

- [ ] **Step 5: Implement token-scoped report loading**

The route verifies the HttpOnly analysis cookie, returns 401 without access, and exposes no storage paths or raw source payloads. Return `Cache-Control: private, no-store` online; the service worker in Task 13 explicitly controls optional local offline caching.

- [ ] **Step 6: Verify progressive persistence**

Run:

```bash
npm run test -- tests/unit/analysis
npm run test:integration -- tests/integration/progressive-report.test.ts
npm run typecheck
```

Expected: the report is readable after baseline assembly, later enrichment creates a new current run result, and all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/analysis src/features/report/load-report.ts src/app/api/analyses tests/unit/analysis tests/integration/progressive-report.test.ts
git commit -m "feat(report): assemble progressive evidence results"
```

---

