### Task 4: Build localized analysis creation and private token exchange

**Files:**
- Create: `messages/et.json`
- Create: `messages/en.json`
- Create: `src/i18n/request.ts`
- Create: `src/middleware.ts`
- Create: `src/app/[locale]/layout.tsx`
- Create: `src/app/[locale]/page.tsx`
- Create: `src/features/submission/create-analysis.ts`
- Create: `src/features/submission/submission-form.tsx`
- Create: `src/features/report/access-bootstrap.tsx`
- Create: `src/app/api/analyses/route.ts`
- Create: `src/app/api/analyses/[publicId]/access/route.ts`
- Create: `tests/unit/submission/create-analysis.test.ts`
- Create: `tests/unit/submission/submission-form.test.tsx`

**Interfaces:**
- Consumes: `createAccessToken` and analysis repositories from Task 3.
- Produces: `createAnalysis(input: CreateAnalysisInput): Promise<CreateAnalysisResult>`.
- Produces: URL shape `/{locale}/a/{publicId}#access={rawToken}`.

- [ ] **Step 1: Write failing creation tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createAnalysis } from "@/features/submission/create-analysis";

describe("createAnalysis", () => {
  it("creates an initial job and returns a fragment secret", async () => {
    const repo = {
      create: vi.fn().mockResolvedValue({ publicId: "7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1" }),
    };
    const result = await createAnalysis(
      { locale: "et", listingUrl: "https://www.auto24.ee/soidukid/123456" },
      { analyses: repo as never },
    );
    expect(repo.create).toHaveBeenCalledOnce();
    expect(result.url).toMatch(/^\/et\/a\/7c5ad3db-7fdb-469e-a96c-d10bc2dd5fb1#access=/);
  });

  it("rejects non-http URLs", async () => {
    await expect(createAnalysis({ locale: "en", listingUrl: "javascript:alert(1)" }, {} as never)).rejects.toThrow("valid http URL");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm run test -- tests/unit/submission`

Expected: FAIL because the feature modules do not exist.

- [ ] **Step 3: Implement the creation use case and route**

Accept only `https:` URLs. Recognize Auto24 by hostname but allow an unsupported URL to proceed into fallback state. Create analysis, input, run, and `capture_listing` job atomically through the repository. Return the fragment-secret URL. The route validates input with Zod and returns 201 or a localized 400 response.

- [ ] **Step 4: Implement localized submission UI**

The form contains one labeled URL input, one primary action, and a compact explanation. Keep the hero within the first viewport. Add an inline fallback disclosure for pasted description and screenshots only after unsupported-source or fetch failure state, not as competing primary controls.

- [ ] **Step 5: Implement fragment-token exchange**

`access-bootstrap.tsx` reads `#access=` once, posts it to `access/route.ts`, and refreshes the report after success. `access/route.ts` accepts `{ token }`, hashes it, checks buffer lengths before `timingSafeEqual`, and sets a signed HttpOnly, Secure, SameSite=Lax cookie named `kontroll_access_{publicId}` with path `/`. Every report request revalidates that cookie against the public ID. The bootstrap keeps the fragment in the shareable URL but never sends it in a query string or request log.

- [ ] **Step 6: Verify unit, component, locale, and type behavior**

Run:

```bash
npm run test -- tests/unit/submission
npm run typecheck
npm run lint
```

Expected: all commands exit 0 and both locale files contain the same keys.

- [ ] **Step 7: Commit**

```bash
git add messages src/i18n src/middleware.ts src/app src/features/submission tests/unit/submission
git commit -m "feat(submission): create private analyses"
```

---

