# Task 7 report: normalize vehicle identity and deterministic baseline findings

## Status

Implemented and committed Task 7 on `codex/used-car-prototype`.

- Base commit: `28050f7`
- Commit: `c4e2c8c feat(analysis): add deterministic baseline checks`
- Unrelated `tests/unit/.DS_Store` was left untracked and unstaged.

## Implementation

- Added `src/analysis/normalize.ts` with the smallest Task 8-ready `NormalizedVehicle`: make, model, year, mileage in km, fuel, transmission, VIN, registration plate, optional generation/engine/gearbox variants, per-field provenance, and explicit conflicts.
- Estonian values are normalized for spacing, mileage (`332 000 km`), fuel (`Diisel`), transmission (`Automaat`/`Manuaal`), VIN casing, and registration-plate formatting.
- Conflicting normalized values leave the canonical field undefined and retain every distinct value with source IDs.
- Added `src/analysis/baseline-checks.ts`, which returns persistence-ready domain `Evidence`, `Finding`, and `Action` records with deterministic UUID-shaped IDs.
- Implemented exactly the six required baseline rules: unsupported major maintenance, missing automatic gearbox-service detail, mileage disagreement, missing official-check identity, missing inspection images, and an unsupported no-investment claim.
- Every emitted important finding has linked evidence and one action. Listing/seller statements only create unverified evidence and open findings; none can create a confirmed finding.

## Test-first evidence

Each test has a preceding comment naming the production regression it catches, uses literal snapshot inputs, and asserts observable output rather than mocks or internal constants.

### RED

Command:

```sh
npm run test -- tests/unit/analysis
```

Output:

```text
Test Files  2 failed (2)
Tests  no tests

FAIL  tests/unit/analysis/baseline-checks.test.ts
Error: Failed to resolve import "@/analysis/baseline-checks". Does the file exist?

FAIL  tests/unit/analysis/normalize.test.ts
Error: Failed to resolve import "@/analysis/normalize". Does the file exist?
```

This is the expected failure before either production module existed.

### GREEN

Command:

```sh
npm run test -- tests/unit/analysis
```

Output:

```text
Test Files  2 passed (2)
Tests  10 passed (10)
```

## Final verification

Command:

```sh
npm run test -- tests/unit/analysis && npm run typecheck && npm run lint && npm run test && git diff --check
```

Output:

```text
Test Files  2 passed (2)
Tests  10 passed (10)

> kontroll@0.1.0 typecheck
> tsc --noEmit

> kontroll@0.1.0 lint
> eslint .

Test Files  17 passed (17)
Tests  99 passed (99)
```

`git diff --check` produced no output and exited successfully.

## Files changed

- `src/analysis/normalize.ts`
- `src/analysis/baseline-checks.ts`
- `tests/unit/analysis/normalize.test.ts`
- `tests/unit/analysis/baseline-checks.test.ts`

## Self-review

Reviewed all four changed files before commit. No defects found in the Task 7 scope: field conflicts resolve to undefined rather than a preferred value; all six rules generate evidence-linked open findings and actions; deterministic IDs derive solely from snapshot content plus rule/material; no persistence, research, API, worker, UI, or model-specific logic was added.

## Concerns

- Image coverage is intentionally conservative: only meaningful URL labels establish the four requested image categories. Opaque URLs remain insufficient for deterministic remote-image coverage.
- `ListingFact` has no source-class field, so conflicting mileage facts are represented as listing evidence while retaining each fact's source ID.

## Fix round 1/5

### Status and commit

- Commit: `e4d156c fix(analysis): harden identity and evidence handling`
- The unrelated `tests/unit/.DS_Store` remained untracked and unstaged.

### Review findings addressed

1. Deterministic IDs now include marketplace, source ID, source URL, content hash, entity, rule, and detail. Identical raw content from different listings no longer collides while retries for one snapshot remain stable.
2. The no-investment rule now runs only when the snapshot has no explicit maintenance evidence reference. Recognized service-document image references and screenshot references suppress the unsupported absence assertion.
3. Mileage parsing accepts one complete kilometre quantity with supported grouping and rejects mixed quantities, miles, and shorthand such as `210k km`.
4. VIN normalization requires 17 standards-compatible characters, excludes `I`, `O`, and `Q`, and rejects repeated-character placeholders. Registration plates are limited to realistic Estonian numeric-prefix car, motorcycle, trailer, and special formats.
5. When VIN or plate conflicts prevent a resolved official-check identity, the finding describes the unresolved conflict and links each contradictory value instead of claiming no value was supplied.
6. Raw image URLs and screenshot references now establish only unclassified image coverage. The image rule reports coverage as unverified and does not infer requested categories from URL words or opaque screenshot references.

Exactly the original six rules remain. All findings remain open, claim evidence remains unverified, contradiction evidence uses the canonical `contradicted` state, and every finding retains linked evidence and an action.

### RED

Command:

```sh
npm run test -- tests/unit/analysis
```

Output:

```text
Test Files  2 failed (2)
Tests  15 failed | 11 passed (26)
```

The failures reproduced all review findings: three unsupported mileage forms, four invalid VINs, two invalid plates, one stale identity-absence message, two no-investment evidence-gating cases, one ID collision, one VIN-conflict evidence case, and one unclassified-image wording case.

### Incremental GREEN

Commands and outputs:

```text
$ npm run test -- tests/unit/analysis/normalize.test.ts
Test Files  1 passed (1)
Tests  14 passed (14)

$ npm run test -- tests/unit/analysis/baseline-checks.test.ts
Test Files  1 passed (1)
Tests  12 passed (12)
```

### Final GREEN

Command:

```sh
npm run test -- tests/unit/analysis && npm run test && npm run typecheck && npm run lint && git diff --check
```

Output:

```text
Test Files  2 passed (2)
Tests  26 passed (26)

Test Files  17 passed (17)
Tests  115 passed (115)

> kontroll@0.1.0 typecheck
> tsc --noEmit

> kontroll@0.1.0 lint
> eslint .
```

`git diff --check` produced no output and exited successfully.

### Files changed

- `src/analysis/normalize.ts`
- `src/analysis/baseline-checks.ts`
- `tests/unit/analysis/normalize.test.ts`
- `tests/unit/analysis/baseline-checks.test.ts`

### Self-review

Reviewed the complete fix diff before commit. The patch is confined to the two Task 7 modules and their behavior-level tests. It preserves canonical domain records, deterministic ordering and IDs, unresolved conflicts, the six-rule boundary, evidence links, and generated actions. No auth, persistence, research, worker, route, or UI behavior changed.

### Concerns

- `ListingSnapshot` does not expose structured image-category metadata. Image and screenshot references therefore remain unclassified; the baseline finding requests labeled evidence without claiming a category is absent.
- `ListingFact` still has no source-class field, so identity-conflict evidence retains source IDs but uses the listing source class.
