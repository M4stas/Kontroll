### Task 13: Preserve the latest report and checklist for offline viewing

**Files:**
- Create: `public/sw.js`
- Create: `src/features/offline/register-worker.tsx`
- Create: `src/features/offline/report-cache.ts`
- Create: `tests/unit/offline/report-cache.test.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/features/report/viewing-checklist.tsx`
- Modify: `src/features/report/report-view.tsx`
- Modify: `tests/e2e/analysis.spec.ts`

**Interfaces:**
- Produces: `cacheReport(publicId: string, report: AnalysisReport): Promise<void>`.
- Produces: `loadCachedReport(publicId: string): Promise<AnalysisReport | null>`.
- Produces: `clearCachedReport(publicId: string): Promise<void>`.

- [ ] **Step 1: Write failing cache-isolation tests**

```ts
import { describe, expect, it } from "vitest";
import { cacheReport, clearCachedReport, loadCachedReport } from "@/features/offline/report-cache";

describe("offline report cache", () => {
  it("isolates cached data by public analysis ID", async () => {
    await cacheReport("analysis-a", { verdict: "worth_viewing" } as never);
    expect(await loadCachedReport("analysis-b")).toBeNull();
    expect((await loadCachedReport("analysis-a"))?.verdict).toBe("worth_viewing");
    await clearCachedReport("analysis-a");
    expect(await loadCachedReport("analysis-a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run offline tests and verify failure**

Run: `npm run test -- tests/unit/offline`

Expected: FAIL because cache helpers do not exist.

- [ ] **Step 3: Implement local report and checklist persistence**

Store the latest validated report JSON and checklist state in IndexedDB under the public analysis ID. Never store the raw access token. Display a visible offline-state notice when cached data is used and provide a "Remove offline copy" action.

- [ ] **Step 4: Register a minimal service worker**

Cache only the report shell and static assets after a successful authenticated load. Use network-first for report JSON and cache fallback only when the network fails. Do not cache submission requests, uploads, signed URLs, or API errors.

- [ ] **Step 5: Test offline behavior in Playwright**

Load a report online, mark a checklist item, switch the context offline, reload, and verify the report plus checklist remain visible. Return online, clear the offline copy, switch offline again, and verify the app explains that no local copy exists.

- [ ] **Step 6: Run offline and accessibility checks**

Run:

```bash
npm run test -- tests/unit/offline
npm run test:e2e -- tests/e2e/analysis.spec.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0 and the offline scenario passes.

- [ ] **Step 7: Commit**

```bash
git add public/sw.js src/features/offline src/app/layout.tsx src/features/report tests/unit/offline tests/e2e/analysis.spec.ts
git commit -m "feat(offline): retain viewing report locally"
```

---

