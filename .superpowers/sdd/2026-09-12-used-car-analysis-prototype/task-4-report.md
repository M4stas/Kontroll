# Task 4 report: localized submission and private capability bootstrap

## Status

Complete against base commit `651ed26`. The implementation preserves the inherited Task 4 work and finishes the localized submission flow, private fragment-token exchange, shared server-side access verification, and compact inspection-sheet landing page. No remote Supabase work, report UI, signup flow, or pricing behavior was added.

## Delivered behavior

- Added Estonian and English routes and message catalogs with parity coverage.
- Added a single-input listing submission form with localized validation, Auto24 recognition, and an inline fallback disclosure for unsupported HTTPS marketplaces or request failure.
- Restricted listing input to HTTPS. Auto24 URLs use the normal URL input type; other HTTPS sources use `url_with_fallback`.
- Reused Task 3's `create_analysis` repository seam, which atomically creates the analysis, input, initial run, and `capture_listing` job.
- Returned private report URLs as `/{locale}/a/{publicId}#access={rawToken}`. The raw capability remains in the fragment and is posted only in the access request body.
- Added a one-shot client bootstrap that exchanges the fragment capability and refreshes the report after success without removing the fragment.
- Added an HttpOnly, Secure, SameSite=Lax access cookie scoped to `/`, named `kontroll_access_{publicId}`.
- Added a shared server access helper and minimal repository lookup for per-request persisted-token revalidation.
- Added a compact, top-weighted, left-aligned dark inspection-sheet landing page with 4px control radius and no gradients, glass effects, car artwork, or dashboard chrome.

## Security review

The cookie payload contains the raw 32-byte base64url capability plus an HMAC-SHA256 signature. The signature is keyed by `ANALYSIS_COOKIE_SECRET` and binds both `publicId` and the raw token using an unambiguous separator.

Verification rejects malformed or non-canonical encodings and checks decoded token and digest lengths before any `timingSafeEqual` call. It verifies the HMAC first, hashes the recovered raw token with SHA-256, and then constant-time compares that candidate digest with the persisted token hash. The persisted hash is reloaded for every report-access verification.

The raw token is never placed in a query parameter or emitted to a log. Creation returns it only in the URL fragment; bootstrap sends it in a JSON POST body.

## TDD and review record

- Preserved six inherited Task 4 unit/component test files and confirmed their 18 tests passed before further changes.
- Observed lint RED for raw internal locale anchors, replaced them with Next.js links, and confirmed focused lint GREEN.
- Added a browser-level regression for compact, left-aligned first-viewport geometry. After installing the missing local Playwright runtime, observed the assertion fail at heading `y = 189.609375`, then removed vertical centering and the form column offset; the regression passed.
- Self-reviewed the staged diff because the task explicitly prohibited subagents. Checked scope, token flow, HMAC/public-ID binding, comparison order, cookie attributes, URL handling, localization parity, and visual constraints. No unresolved code finding remained.

## Verification

- `npm run test -- tests/unit/submission`: 6 files, 18 tests passed.
- `npm run test`: 12 files, 58 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:e2e -- tests/e2e/submission.spec.ts`: 1 Chromium test passed.
- Manual browser verification: English desktop and Estonian mobile passed, including language switching, Auto24/unsupported URL status behavior, and fallback disclosure.
- `git diff --check`: passed.

## Concerns and follow-up

- Next.js 16.3.5 warns that the `middleware` convention is deprecated in favor of `proxy`. The brief explicitly calls for `src/middleware.ts`; migration is intentionally deferred to avoid expanding Task 4.
- Playwright's development server reports an HMR origin warning because the configured test base URL uses `127.0.0.1` while Next advertises `localhost`. It does not affect the regression result and changing global test configuration is outside this task.
