### Task 2: Define the evidence, finding, confidence, and verdict domain

**Files:**
- Create: `src/domain/analysis.ts`
- Create: `src/domain/schemas.ts`
- Create: `src/domain/confidence.ts`
- Create: `src/domain/verdict.ts`
- Create: `tests/unit/domain/confidence.test.ts`
- Create: `tests/unit/domain/verdict.test.ts`

**Interfaces:**
- Produces: `Evidence`, `Finding`, `VehicleFact`, `Action`, `AnalysisReport`, `ConfidenceBand`, and `Verdict`.
- Produces: `calculateConfidence(input: ConfidenceInput): ConfidenceBand`.
- Produces: `calculateVerdict(findings: Finding[], confidence: ConfidenceBand): Verdict`.

- [ ] **Step 1: Write failing confidence and verdict tests**

```ts
import { describe, expect, it } from "vitest";
import { calculateConfidence } from "@/domain/confidence";

describe("calculateConfidence", () => {
  it("keeps confidence low when exact vehicle identity is unresolved", () => {
    expect(calculateConfidence({ identity: 0.45, coverage: 0.9, agreement: 0.9, freshness: 0.9 })).toBe("low");
  });

  it("returns high only when every confidence dimension is strong", () => {
    expect(calculateConfidence({ identity: 0.9, coverage: 0.85, agreement: 0.9, freshness: 0.8 })).toBe("high");
  });
});
```

```ts
import { describe, expect, it } from "vitest";
import { calculateVerdict } from "@/domain/verdict";
import type { Finding } from "@/domain/analysis";

const finding = (severity: Finding["severity"], state: Finding["state"]): Finding => ({
  id: crypto.randomUUID(),
  category: "mechanical",
  severity,
  state,
  title: "Example finding",
  explanation: "Evidence-backed test finding.",
  nextAction: "Arrange an inspection.",
  evidenceIds: ["evidence-1"],
});

describe("calculateVerdict", () => {
  it("returns likely_skip for a confirmed critical finding", () => {
    expect(calculateVerdict([finding("critical", "confirmed")], "high")).toBe("likely_skip");
  });

  it("returns proceed_cautiously when important checks remain open", () => {
    expect(calculateVerdict([finding("important", "open")], "moderate")).toBe("proceed_cautiously");
  });

  it("returns worth_viewing when only context findings remain", () => {
    expect(calculateVerdict([finding("context", "open")], "high")).toBe("worth_viewing");
  });
});
```

- [ ] **Step 2: Run the tests and verify missing-module failures**

Run: `npm run test -- tests/unit/domain`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement domain types and Zod schemas**

Define exact unions:

```ts
export type Verdict = "worth_viewing" | "proceed_cautiously" | "likely_skip";
export type ConfidenceBand = "low" | "moderate" | "high";
export type FindingSeverity = "critical" | "important" | "context";
export type FindingState = "open" | "confirmed" | "cleared";
export type VerificationState = "unverified" | "corroborated" | "official" | "contradicted" | "not_checked";
export type EvidenceRelation = "supports" | "contradicts";
export type SourceClass = "official_registry" | "manufacturer" | "independent" | "forum" | "listing" | "seller" | "buyer";
```

`Finding.evidenceIds` must be non-empty for `critical` and `important` findings. Mirror all external and persisted structures with strict Zod schemas.

- [ ] **Step 4: Implement deterministic policies**

Use the minimum confidence dimension as a safety floor. Return `high` only when every dimension is at least `0.8`, `moderate` when every dimension is at least `0.55`, otherwise `low`.

Verdict precedence is:

1. Confirmed critical finding: `likely_skip`.
2. Two or more confirmed important findings: `likely_skip`.
3. Any open critical, confirmed important, or open important finding: `proceed_cautiously`.
4. Low confidence: `proceed_cautiously`.
5. Otherwise: `worth_viewing`.

- [ ] **Step 5: Run focused and full unit tests**

Run:

```bash
npm run test -- tests/unit/domain
npm run typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain tests/unit/domain
git commit -m "feat(domain): define evidence and verdict rules"
```

---

