# Checkpoint 4 release evidence

Release candidate for the current online report. [Plan](../plans/2026-10-05-checkpoint-4-release.md).
[Agent policy](../../agent-policy.md) remained read-only.

## Scope and environment

The user explicitly deferred offline saving and a persistent viewing checklist.
Viewing actions remain a reference list. Manual browser testing is English-only,
following the checkpoint 3 preference. ET interface controls have regression tests;
saved conclusions retain their pinned language.

- Main baseline: `1290cf7`, merged PR 9.
- Tested application source: `21954ff`, following release controls commit `76174dd`.
- Production preview: `http://localhost:3004/en`.
- Existing Auto24 services and shared Supabase preserve their data.
- Demo worker is scoped to reports created at or after `2026-10-05T20:41:00Z`.
- Integration tests used a separate `cars-checkpoint-4-release` project on ports
  55320–55329. CLI 2.117.0 used the working PostgreSQL 17.6.1.167 image. The
  disposable stack was stopped and temporary configuration restored after testing.

## Fixes and regression evidence

Hardcoded activity, evidence, and report controls now use ET/EN messages. Exact
localhost development origins allow hydrated script loading without admitting an
unrelated origin. Next.js and matching ESLint configuration were patched to 16.3.8.

A real seller-answer supplement reproduced `Could not pin review run snapshot`.
Inherited capture photos had deterministic citation IDs that the ownership helper
rejected. The migration admits those IDs only when canonical same-analysis
source, ancestor lineage, deterministic citation, storage, hash, and MIME match.
Negative public-RPC tests reject modified storage/hash/MIME and a sibling citation.
The valid snapshot then pins on the same lease. The migration replaces a helper;
it does not rewrite reports or stored evidence. It was applied to the local demo DB.

A second regression reproduced missing image URLs during the child image pass.
Parent assembly evidence omitted the child's remapped photo IDs. Report loading
now includes current review photo evidence alongside the previous assessment,
within the existing analysis and lineage query. Completed and in-progress image
URLs are asserted. Private image access still requires the report cookie and
owned bytes. Exact repeated seller instructions are removed from both visible
and copied messages, preserving first-occurrence order.

## Automated verification on October 7

- Full unit suite: 52 files, 529 tests passed.
- Full isolated integration suite: 8 files, 79 tests passed, 69.66 seconds.
  Command: `npx vitest run --config vitest.integration.config.ts --testTimeout=30000`.
  The runner timeout accommodates host load; product assertions remain unchanged.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Production browser acceptance uses the rebuilt `next start` app, not the dev server.
- Independent final source review is clean, including migration, privacy,
  concurrency, DTO transition, seller deduplication, tests, and startup README.

Earlier disk exhaustion, stopped Docker, PostgreSQL image initialization failures,
shared-queue test failures, and default runner timeouts are superseded by these
successful isolated checks. No shared database was reset for testing.

## Manual and live journey evidence

Real Auto24 listing 4332399 completed capture, seven photo passes, text review, and
final review in both the in-app browser and Brave. Reports:
`57a28f48-31a6-4492-876c-01bd2b7698ac` and
`f3003133-bc0b-4f95-bef0-455a0987a1e9`.
Native Brave clipboard paste previously confirmed the copied seller request.
The in-app browser clipboard helper returned empty text, so that helper alone is
not counted as proof of copied bytes.

Final production acceptance passed on October 7. A clearly labelled buyer note
was accepted, queued, completed at the same URL, and survived reload. All seven
photos loaded at desktop width 1280 and mobile 390×844 with no overflow. The
real-photo evidence popup opened and closed. A separate unauthorized browser
received private-access denial. Exact repeated seller instructions disappeared.
Model-generated requests with different wording can still ask for similar VIN
information; no semantic rewriting of saved actions is included. Existing user
PDF and seller answers were preserved. Brave was left untouched during the final
retake because the user was using it.

The new review finished within ten seconds, before an intermediate screenshot.
The integration hook proves image URL availability during the image pass.
Final local screenshots are `/private/tmp/cp4-final-desktop-photos.jpg`,
`/private/tmp/cp4-final-mobile-photos.jpg`,
`/private/tmp/cp4-final-mobile-evidence.jpg`,
`/private/tmp/cp4-final-complete.jpg`, and
`/private/tmp/cp4-final-seller-request.jpg`. They are private local evidence,
not public repository attachments.

## Startup and limitations

See the checkpoint 4 section in README for Node 24, private environment variables,
Auto24, Supabase migrations, web server, scoped worker, and private-link startup.
The report requires online services. Cookie expiry/removal or secret rotation loses
browser access; a URL without its private fragment grants no access in another
browser. No offline save, removal of a saved offline copy, or persistent checklist
is implemented or claimed tested.

Runtime dependency audit reported zero advisories. Five high development-only
findings remain in the ESLint/fast-glob/micromatch/braces chain. No patched braces
release was available during validation; the suggested forced change downgraded
Next configuration to version 14. That incompatible downgrade is excluded. These
tools process trusted repository files. The original Next ImageResponse advisory
is covered by the compatible patch:
https://github.com/advisories/GHSA-vcvr-r3jv-pc5j.

## Estimates and notifications

Original remaining estimates started October 5 at 20:45 UTC. The initial real
Auto24 journey completed in about 14 minutes against a 30-minute limit. The first
automated gate completed in 17 minutes against a 25-minute limit. Manual testing
and release preparation exceeded their original time limits, and repairs exceeded
the 350 added-nonblank-line limit. Those overruns were reported.

On October 7 at 11:26 UTC, remaining work was estimated at 30–50 minutes overall
and another 30–80 lines. Automated checks and source review completed by 11:31 UTC.
Final manual acceptance and documentation review passed. By 11:41 UTC, about
15 minutes had elapsed since resumption. Added nonblank LOC reached 471, exceeding
the original overall 450-line limit and revised additional 80-line allowance.
This overrun was reported. Counts exclude lockfile, generated files, temporary
configuration, and screenshots. Release PR: https://github.com/M4stas/kontroll/pull/10. All four delivery points are complete.
