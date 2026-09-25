# Task 6 report: Auto24 listing capture and fallback

## Status

Implemented and committed as `12931f4 feat(listings): ingest Auto24 with fallback`.

## Implementation

- Added the `ListingAdapter` contract, typed snapshot data, and typed `fallback_required` outcomes.
- Added an Auto24 adapter that recognizes Auto24 hosts, respects `AUTO24_FETCH_ENABLED`, uses a 15-second anonymous request with a descriptive user agent, and never attempts CAPTCHA or blocking bypasses.
- Parses semantic HTML first, then JSON-LD, then labeled Auto24 rows. All listing facts and claims are marked `unverified`; raw HTML is SHA-256 hashed without storing raw content.
- Returns typed fallback outcomes for disabled fetching, unsupported URLs, blocked responses, missing make/model identity, and request/body failures.
- Added pasted-text/screenshot snapshots with buyer provenance, unverified claims, the original listing URL, and an explicit warning that missing fields are not evidence of a clean vehicle.
- Added a redacted fixture with no seller contact details.

## TDD record

Each test names the regression it catches before the production behavior it exercises. The fetch mock is limited to the external request boundary.

### RED: absent listing modules

Command:

```text
npm run test -- tests/unit/listings
```

Output:

```text
Test Files  2 failed (2)
Tests  no tests
Error: Failed to resolve import "@/listings/auto24" from "tests/unit/listings/auto24.test.ts". Does the file exist?
Error: Failed to resolve import "@/listings/fallback" from "tests/unit/listings/fallback.test.ts". Does the file exist?
```

### RED: response-body failure must stay on the fallback path

Command:

```text
npm run test -- tests/unit/listings
```

Output:

```text
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 7 passed (8)
AssertionError: promise rejected "Error: body read failed" instead of resolving
Caused by: Error: body read failed
```

### GREEN: focused listing tests

Command:

```text
npm run test -- tests/unit/listings
```

Output:

```text
Test Files  2 passed (2)
Tests  8 passed (8)
```

## Final verification

```text
$ npm run test
Test Files  15 passed (15)
Tests  79 passed (79)

$ npm run typecheck
> tsc --noEmit

$ npm run lint
> eslint .

$ git diff --cached --check
(no output; exit 0)
```

The initial typecheck encountered stale generated `.next/dev/types` for the unchanged locale layout. `npm exec next typegen` reported `✓ Types generated successfully`; the required typecheck then passed with exit 0.

## Files changed

- `src/listings/adapter.ts`
- `src/listings/auto24.ts`
- `src/listings/fallback.ts`
- `tests/fixtures/auto24-listing.html`
- `tests/unit/listings/auto24.test.ts`
- `tests/unit/listings/fallback.test.ts`

## Self-review

Reviewed the staged diff against the brief. It is limited to listing capture/fallback; it does not wire worker stages or change price estimation, external reports, research, agents, or UI. The final review caught and corrected the response-body failure path so it returns `fetch_failed` instead of throwing. The staged whitespace check passed. `tests/unit/.DS_Store` was left untracked and unstaged.

## Concerns

- Auto24 markup can change; the semantic, JSON-LD, and labeled-row fallbacks reduce but do not eliminate parser maintenance needs.
- Direct access remains disabled by default and intentionally falls back to buyer-supplied content when unavailable.
- Pull-request creation is blocked locally because the configured GitHub account token is invalid; no push or authentication change was attempted.

## Fix round 1/5 — capture boundary hardening

Committed as `28050f7 fix(listings): harden Auto24 capture boundaries` on top of reviewed base `12931f4`.

### Implementation

- Restricted Auto24 capture to `https:`, default HTTPS ports, empty URL credentials, and the exact hosts `auto24.ee` or `www.auto24.ee`. Unsupported inputs return `unsupported_url` before fetch.
- Added best-effort cancellation for unread response bodies before blocked and other non-OK fallbacks. Null bodies and cancellation failures preserve the typed fallback result.
- Added `seller` to `ListingSourceClass` and classified listing descriptions as unverified seller claims. Auto24 marketplace metadata and source IDs retain listing provenance.
- Kept fallback screenshots as buyer-provided string references, per the controller ruling; Task 12 owns upload attribution changes.
- Replaced the timeout-presence assertion with deterministic fake-time behavior proving no abort through 14,999 ms and `fetch_failed` at 15,000 ms.

### RED/GREEN evidence

#### URL admission RED

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "rejects unsafe or noncanonical Auto24 URL"
Test Files  1 failed (1)
Tests  4 failed | 7 skipped (11)
AssertionError: expected { type: 'snapshot', …(11) } to match object { type: 'fallback_required', …(1) }
```

#### URL admission GREEN

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "rejects unsafe or noncanonical Auto24 URL"
Test Files  1 passed (1)
Tests  4 passed | 7 skipped (11)
```

The final table also includes explicit HTTP coverage, bringing the final focused listing total to 18 tests.

#### Unread response-body cleanup RED

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "unread response body|response body cancellation"
Test Files  1 failed (1)
Tests  3 failed | 1 passed | 11 skipped (15)
AssertionError: expected "cancel" to be called once, but got 0 times
```

#### Unread response-body cleanup GREEN

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "unread response body|response body cancellation"
Test Files  1 passed (1)
Tests  4 passed | 11 skipped (15)
```

#### Seller provenance RED

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "extracts normalized unverified facts"
Test Files  1 failed (1)
Tests  1 failed | 14 skipped (15)
AssertionError: expected [ { …(3) } ] to deep equally contain ObjectContaining{…}
Expected sourceClass: "seller"
Received sourceClass: "listing"
```

#### Seller provenance GREEN

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "extracts normalized unverified facts"
Test Files  1 passed (1)
Tests  1 passed | 14 skipped (15)
```

#### Exact timeout mutation RED

The production timeout was already 15 seconds, so the new behavior test initially passed. To prove the regression test detects the boundary, `FETCH_TIMEOUT_MS` was temporarily changed to `14_999` after the test was written:

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "15-second request timeout"
Test Files  1 failed (1)
Tests  1 failed | 15 skipped (16)
AssertionError: expected { type: 'fallback_required', …(2) } to be undefined
```

#### Exact timeout restored GREEN

After restoring `FETCH_TIMEOUT_MS` to `15_000`:

```text
$ npm run test -- tests/unit/listings/auto24.test.ts -t "15-second request timeout"
Test Files  1 passed (1)
Tests  1 passed | 15 skipped (16)
```

### Final verification

```text
$ npm run test -- tests/unit/listings
Test Files  2 passed (2)
Tests  18 passed (18)

$ npm run test
Test Files  15 passed (15)
Tests  89 passed (89)

$ npm run typecheck
> tsc --noEmit

$ npm run lint
> eslint .

$ git diff --check
(no output; exit 0)

$ git diff --cached --check
(no output; exit 0)
```

### Self-review

Reviewed the complete three-file diff against all four findings and the controller ruling. URL validation occurs before environment lookup and fetch; every response-status branch that exits before `text()` performs safe best-effort body cancellation; seller claims remain unverified; and screenshot ownership was not redesigned. Tests control only fetch responses and time. No worker, UI, research, pricing, or Task 12 behavior changed. `tests/unit/.DS_Store` remains untracked and unstaged.

### Concerns

- The exact-host allowlist intentionally falls back if Auto24 later moves listings to another subdomain.
- Response-body cancellation is intentionally best-effort so cleanup failure cannot replace a typed buyer fallback.
- No push, PR, GitHub authentication change, or subagent dispatch occurred.
