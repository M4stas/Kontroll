### Task 8: Add source policy and reusable vehicle research cache

**Files:**
- Create: `src/research/provider.ts`
- Create: `src/research/cache-key.ts`
- Create: `src/research/source-policy.ts`
- Create: `src/research/official-links.ts`
- Create: `tests/unit/research/cache-key.test.ts`
- Create: `tests/unit/research/source-policy.test.ts`
- Create: `tests/integration/research-cache.test.ts`

**Interfaces:**
- Produces: `buildResearchKey(vehicle: NormalizedVehicle): ResearchKey | null`.
- Produces: `classifyEvidence(source: ResearchSource, vehicle: NormalizedVehicle): EvidenceApplicability`.
- Produces: `ResearchProvider.research(vehicle: NormalizedVehicle): Promise<VehicleResearch>`.

- [ ] **Step 1: Write failing applicability tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyEvidence } from "@/research/source-policy";

describe("classifyEvidence", () => {
  it("keeps model-wide forum complaints as background", () => {
    expect(classifyEvidence({ sourceClass: "forum", make: "Audi", model: "A7" } as never, { make: "Audi", model: "A7", engine: "3.0 TDI" } as never)).toBe("background");
  });

  it("requires exact VIN applicability for recall confirmation", () => {
    expect(classifyEvidence({ sourceClass: "manufacturer", kind: "recall", vinMatched: false } as never, { vin: "WAU..." } as never)).toBe("needs_confirmation");
  });
});
```

- [ ] **Step 2: Run research tests and verify failure**

Run: `npm run test -- tests/unit/research`

Expected: FAIL because research modules do not exist.

- [ ] **Step 3: Implement research keys and source policy**

The cache key includes make, model, generation, engine, gearbox, year range, and mileage band. Return `null` when make, model, and year are not identified. Cache entries expire after 30 days for recalls and 90 days for stable common-issue summaries.

Rank sources by claim type: registry for identity/history, manufacturer for recalls and maintenance, independent technical sources for repair context, forums for leads, and seller/buyer content as unverified input.

- [ ] **Step 4: Implement official source links without unsupported automation**

Provide the Transport Administration checker URL and manufacturer recall search links. The Transport Administration status remains `not_checked` until a compliant result or buyer-supplied record exists. Do not call an undocumented endpoint.

- [ ] **Step 5: Implement repository-backed cache behavior**

Return a fresh exact match before invoking any provider. Store source URLs, retrieval time, applicability fields, schema version, and normalized research result. Never reuse an engine-specific finding for a cache key without an engine match.

- [ ] **Step 6: Verify unit and integration behavior**

Run:

```bash
npm run test -- tests/unit/research
npm run test:integration -- tests/integration/research-cache.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/research tests/unit/research tests/integration/research-cache.test.ts
git commit -m "feat(research): add source policy and cache"
```

---

