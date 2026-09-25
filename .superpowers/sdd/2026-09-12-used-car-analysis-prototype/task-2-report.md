# Task 2 Report: Define the evidence, finding, confidence, and verdict domain

Date: 2026-09-12
Worktree: `~/cars/.worktrees/used-car-prototype`
Branch: `codex/used-car-prototype`
Status: DONE_WITH_CONCERNS
Commit: `722ae3d1126f5c72cbe747271972eecdac339c7b`
Commit subject: `feat(domain): define evidence and verdict rules`

## Outcome

Task 2 is implemented and committed. The commit defines the canonical TypeScript domain contract for evidence, vehicle facts, findings, actions, source summaries, reports, confidence, and verdicts. It adds strict Zod mirrors for every union and object contract, including the resolved supplementary unions and `ConfidenceInput`.

The implementation remains deterministic and limited to the requested domain boundary. It does not add persistence, source adapters, pipeline orchestration, UI, or agent behavior.

## Resolved contract

The implementation includes the brief's exact unions:

- `Verdict`
- `ConfidenceBand`
- `FindingSeverity`
- `FindingState`
- `VerificationState`
- `EvidenceRelation`
- `SourceClass`

It also includes the resolved canonical unions:

- `AnalysisStatus`
- `Locale`
- `ActionKind`
- `ActionStatus`
- `FindingOrigin`

The following exact canonical object contracts are exported:

- `ConfidenceInput`
- `Evidence`
- `VehicleFact`
- `Finding`
- `Action`
- `SourceSummary`
- `AnalysisReport`

`Finding` retains every required field used by the brief's verbatim test and adds only the permitted optional `origin` field.

## Runtime schemas

`src/domain/schemas.ts` exports a Zod schema for every union and object type:

- Union schemas: `VerdictSchema`, `ConfidenceBandSchema`, `FindingSeveritySchema`, `FindingStateSchema`, `VerificationStateSchema`, `EvidenceRelationSchema`, `SourceClassSchema`, `AnalysisStatusSchema`, `LocaleSchema`, `ActionKindSchema`, `ActionStatusSchema`, and `FindingOriginSchema`.
- Object schemas: `ConfidenceInputSchema`, `EvidenceSchema`, `VehicleFactSchema`, `FindingSchema`, `ActionSchema`, `SourceSummarySchema`, and `AnalysisReportSchema`.

Schema safeguards:

- Every object schema is strict and rejects unknown properties.
- IDs, source IDs, record keys, and other non-URL content strings are non-empty.
- Optional URL fields require valid URLs when present.
- Confidence dimensions and persisted confidence values must be finite numbers in the inclusive `0..1` range.
- `capturedAt` and `updatedAt` require ISO datetime strings.
- Critical and important findings require at least one non-empty evidence ID; context findings may use an empty evidence list.
- Arrays are required and receive no defaults.

## Deterministic policies

### Confidence

`calculateConfidence` uses the minimum of identity, coverage, agreement, and freshness as the safety floor:

- `high` when the floor is at least `0.8`.
- `moderate` when the floor is at least `0.55`.
- `low` otherwise.

### Verdict

`calculateVerdict` applies the required precedence in order:

1. Any confirmed critical finding returns `likely_skip`.
2. Two or more confirmed important findings return `likely_skip`.
3. Any open critical, confirmed important, or open important finding returns `proceed_cautiously`.
4. Low confidence returns `proceed_cautiously`.
5. All remaining inputs return `worth_viewing`.

## TDD evidence

### RED

The two brief-provided test files were added verbatim. The resolved schema-focused tests were added in the same RED step for unknown-key rejection, bounded confidence, and the finding evidence invariant.

Command:

```text
npm run test -- tests/unit/domain
```

Result: exit 1, as required. Vitest reported three failed suites and no executed tests because these imports could not be resolved:

```text
@/domain/confidence
@/domain/schemas
@/domain/verdict
```

This is real missing-module RED evidence captured before any production domain module existed.

### GREEN

After adding the minimal implementation, the same focused command exited 0:

```text
Test Files  3 passed (3)
Tests       8 passed (8)
```

## Verification evidence

### Focused domain tests

Command: `npm run test -- tests/unit/domain`

Result: exit 0; 3 files passed and 8 tests passed.

### TypeScript

Command: `npm run typecheck`

Result: exit 0 with no diagnostics.

### Full unit suite before commit

Command: `npm run test`

Result: exit 0; 4 files passed and 9 tests passed. The full suite was run once before commit, after the focused tests and typecheck, as requested.

## Commit

The required files were staged with:

```text
git add src/domain tests/unit/domain
```

The required commit subject was used exactly:

```text
feat(domain): define evidence and verdict rules
```

Created commit:

```text
722ae3d1126f5c72cbe747271972eecdac339c7b
```

The commit contains seven files and 389 inserted lines:

- `src/domain/analysis.ts`
- `src/domain/confidence.ts`
- `src/domain/schemas.ts`
- `src/domain/verdict.ts`
- `tests/unit/domain/confidence.test.ts`
- `tests/unit/domain/schemas.test.ts`
- `tests/unit/domain/verdict.test.ts`

## Self-review

The committed diff `HEAD^..HEAD` was reviewed directly because the task explicitly prohibited subagents.

Checks completed:

- The commit contains only the four requested domain modules and three Task 2 test files.
- The two brief-provided tests are present verbatim.
- All resolved union literals match the ruling exactly.
- All object fields, optionality, array types, nullability, and record shape match the ruling exactly.
- Every union and object type has an exported runtime schema.
- Every object schema calls `.strict()`.
- Non-empty string, URL, confidence, datetime, and finding-evidence constraints are enforced at the runtime boundary.
- Confidence uses the minimum dimension and exact `0.8`/`0.55` thresholds.
- Verdict branches preserve the five-level precedence without allowing low confidence to override a stronger `likely_skip` result.
- No defaulting, persistence, source access, pipeline, UI, or agent behavior was introduced.
- `git diff HEAD^ HEAD --check` exited 0.
- The worktree was clean after commit.

Self-review result: clean for Task 2 scope; no Critical, Important, or Minor findings.

## Concerns and deferred gates

- The global production-completion gate calls for a separate subagent review, but this task explicitly prohibited spawning subagents. The requested inline self-review is complete; independent review remains deferred to the coordinating workflow.
- No pull request was created because this task requested a task commit and the implementation plan reserves branch-wide PR creation for the release task.
- Manual desktop/mobile E2E testing does not apply to this domain-only change; no frontend was changed.

These deferred branch-level gates do not affect the committed Task 2 implementation or its verification results, but they prevent claiming the overall product branch is production-complete.

## Fix round 1

Date: 2026-09-12
Baseline commit: `722ae3d1126f5c72cbe747271972eecdac339c7b`
Fix commit: `634dcb3a3f28f8523aa90db943122517bbf2a430`
Fix commit subject: `fix(domain): enforce trust and confidence invariants`
Status: DONE

### Finding mapping

1. **Untrusted evidence could become official — fixed.** `EvidenceSchema` now performs cross-field validation and rejects `verification: "official"` when `sourceClass` is `listing`, `seller`, or `buyer`. Tests cover all three rejected classes, all four allowed non-official verification states for each class, and confirm that `official_registry`, `manufacturer`, `independent`, and `forum` remain unrestricted by this invariant.
2. **The public confidence function accepted invalid runtime numbers — fixed.** `calculateConfidence` now parses its input through the canonical `ConfidenceInputSchema` before calculating the floor. It rejects values above one, below zero, positive infinity, and `NaN`; it does not clamp them.
3. **Confidence and verdict policy coverage was incomplete — fixed.** Table-driven confidence tests cover the exact `0.8` and `0.55` boundaries and values immediately below both floors. Verdict tests cover confirmed critical, two confirmed important, open critical, one confirmed important, open important, low-confidence fallback, the otherwise branch, and confirmed-critical precedence over low confidence.

### Root-cause reproduction

Command:

```text
npx tsx -e 'import { calculateConfidence } from "./src/domain/confidence.ts"; import { EvidenceSchema } from "./src/domain/schemas.ts"; const evidence = { id: "evidence-1", sourceId: "seller-1", sourceClass: "seller", claim: "No faults", applicability: "vehicle", confidence: 0.9, verification: "official", capturedAt: "2026-09-12T12:00:00.000Z" }; console.log(JSON.stringify({ invalidConfidenceResult: calculateConfidence({ identity: 2, coverage: 2, agreement: 2, freshness: 2 }), sellerOfficialAccepted: EvidenceSchema.safeParse(evidence).success }));'
```

Output:

```text
{"invalidConfidenceResult":"high","sellerOfficialAccepted":true}
```

This reproduced both review findings against the baseline before tests or implementation changed.

### RED evidence

Command:

```text
npm run test -- tests/unit/domain
```

Output, exit 1:

```text
RUN  v5.0.0 ~/cars/.worktrees/used-car-prototype

❯ tests/unit/domain/confidence.test.ts (10 tests | 4 failed)
  × rejects a above one confidence dimension
  × rejects a below zero confidence dimension
  × rejects a not finite confidence dimension
  × rejects a not a number confidence dimension
❯ tests/unit/domain/schemas.test.ts (13 tests | 3 failed)
  × rejects official verification for listing evidence
  × rejects official verification for seller evidence
  × rejects official verification for buyer evidence

Test Files  2 failed | 1 passed (3)
Tests       7 failed | 25 passed (32)
```

All seven failures were the intended missing validations. The new verdict policy cases passed during RED, confirming that the existing implementation already followed those branches while lacking explicit regression coverage.

### Focused GREEN verification

Command:

```text
npm run test -- tests/unit/domain
```

Output, exit 0:

```text
RUN  v5.0.0 ~/cars/.worktrees/used-car-prototype

Test Files  3 passed (3)
Tests       32 passed (32)
Duration    393ms
```

### TypeScript verification

Command:

```text
npm run typecheck
```

Output, exit 0:

```text
> kontroll@0.1.0 typecheck
> tsc --noEmit
```

No diagnostics were emitted.

### Full unit verification

Command:

```text
npm run test
```

Output, exit 0:

```text
RUN  v5.0.0 ~/cars/.worktrees/used-car-prototype

Test Files  4 passed (4)
Tests       33 passed (33)
Duration    536ms
```

### Fix commit

Command:

```text
git commit -m "fix(domain): enforce trust and confidence invariants"
```

Output:

```text
[codex/used-car-prototype 634dcb3] fix(domain): enforce trust and confidence invariants
5 files changed, 139 insertions(+), 2 deletions(-)
```

### Self-review

The exact `722ae3d..634dcb3` fix diff was reviewed inline because subagents were explicitly prohibited.

- Scope is limited to `src/domain/confidence.ts`, `src/domain/schemas.ts`, and the three authorized domain test files.
- `calculateConfidence` uses `ConfidenceInputSchema.parse`, preserving one canonical runtime contract and rejecting rather than clamping invalid input.
- The source-trust refinement rejects only the three specified untrusted source classes when paired with `official`.
- Every explicitly allowed untrusted verification state and every explicitly unrestricted source class has passing regression coverage.
- Every confidence floor and verdict branch named by the review has literal, independently derived expectations.
- No persistence, adapter, UI, pipeline, or agent behavior changed.
- `git diff HEAD^ HEAD --check` exited 0.
- The worktree was clean after commit.

Self-review result: clean; no Critical, Important, or Minor findings in Fix round 1.

### Fix-round concerns

No Task 2 code concerns remain. The branch-level independent-review and pull-request gates remain deferred under the same scope constraints documented above.
