### Task 7: Normalize vehicle identity and produce baseline findings

**Files:**
- Create: `src/analysis/normalize.ts`
- Create: `src/analysis/baseline-checks.ts`
- Create: `tests/unit/analysis/normalize.test.ts`
- Create: `tests/unit/analysis/baseline-checks.test.ts`

**Interfaces:**
- Consumes: `ListingSnapshot` from Task 6.
- Produces: `normalizeVehicle(snapshot: ListingSnapshot): NormalizedVehicle`.
- Produces: `runBaselineChecks(vehicle: NormalizedVehicle, snapshot: ListingSnapshot): BaselineResult`.

- [ ] **Step 1: Write failing normalization and contradiction tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeVehicle } from "@/analysis/normalize";

describe("normalizeVehicle", () => {
  it("normalizes Estonian mileage and preserves its source", () => {
    const vehicle = normalizeVehicle({ facts: [{ key: "mileage", value: "332 000 km", sourceId: "listing-1", verification: "unverified" }] } as never);
    expect(vehicle.mileageKm).toBe(332000);
    expect(vehicle.provenance.mileageKm).toContain("listing-1");
  });
});
```

```ts
import { describe, expect, it } from "vitest";
import { runBaselineChecks } from "@/analysis/baseline-checks";

describe("runBaselineChecks", () => {
  it("turns an unsupported major-service claim into an open important finding", () => {
    const result = runBaselineChecks({ mileageKm: 332000 } as never, { claims: [{ text: "Suur hooldus tehtud", evidenceIds: [] }] } as never);
    expect(result.findings).toContainEqual(expect.objectContaining({ severity: "important", state: "open" }));
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "seller_question" }));
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm run test -- tests/unit/analysis`

Expected: FAIL because normalization and baseline modules do not exist.

- [ ] **Step 3: Implement normalization with field-level provenance**

Normalize year, mileage, fuel, transmission, VIN, and registration plate. Leave generation, exact engine, and gearbox variant unresolved unless the source provides enough detail. Record conflicts instead of selecting a convenient value.

- [ ] **Step 4: Implement baseline checks**

Cover these first rules:

1. Unsupported major maintenance claim.
2. Missing gearbox service detail on an automatic vehicle.
3. Listing mileage disagreement.
4. VIN or plate missing for official checks.
5. No underside, engine-bay, instrument-cluster, or service-document images.
6. Description says no investment needed while material maintenance evidence is absent.

Each rule returns a finding, linked evidence IDs, and at least one action. Rules cannot produce `confirmed` from a listing claim alone.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
npm run test -- tests/unit/analysis
npm run typecheck
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/normalize.ts src/analysis/baseline-checks.ts tests/unit/analysis
git commit -m "feat(analysis): add deterministic baseline checks"
```

---

