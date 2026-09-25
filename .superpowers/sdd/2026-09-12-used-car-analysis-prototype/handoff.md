# Resume handoff — 2026-09-25

Repository: `M4stas/kontroll`. Branch: `codex/used-car-prototype`. Existing PR: https://github.com/M4stas/kontroll/pull/1. This is a WIP handoff, not a claim that the prototype is finished or merge-ready.

The latest fully verified feature commit before the handoff was `d1a7ed9`: 272 unit, 55 integration, 4 seeded-browser tests, typecheck, lint, and build passed. A small later ET prompt/UI/README change was interrupted and is being committed as WIP for portability; do not assume those earlier test results cover it. The entire SDD directory, including `agents.md`, `progress.md`, reports, diffs, and screenshots, was retained for review and token-efficiency analysis.

For the WIP edits specifically, 35 focused unit tests, typecheck, lint, and a code-only staged diff check passed before handoff. A full gate and manual browser test were not rerun. Historical review-package `.diff` files contain their original whitespace, so a diff check over the entire artifact archive emits whitespace warnings; do not treat that as a new source-code regression.

User-approved lean prototype scope: Auto24 URL or pasted-listing fallback; no signup; private evidence-backed verdict; seller questions/photo requests; in-person checklist; image follow-up; ET/EN; optional non-blocking Luna. Automatic recall/forum research and PDF interpretation are deferred. PDF uploads are private but not analyzed. Unavailable sources must remain `not_checked`. Price estimation and paid reports remain excluded. No CAPTCHA bypass.

Next work: verify the WIP ET changes; exercise disabled and blocked Auto24 capture through the real worker in desktop/mobile browser, including paste/screenshots and private access; fix any failures; run full gates; obtain an independent scoped review on the post-`50419b5` fix range; update PR body with current scope and evidence. The earlier screenshots prove a controlled partial→complete flow and seeded same-URL verdict change, not live Auto24 or Luna behavior. High confidence must not be awarded without independent vehicle-specific evidence.

On the other computer, fetch this branch, install dependencies, start local Supabase, apply migrations, fill a new `.env.local` as described in the root README, then run the app and worker. Local `.env.local`, Docker/Supabase data, and private test reports are not committed; do not expect them to transfer through Git. Do not reset a non-disposable database.

Future agent preference: implementation `gpt-6-luna` / xhigh; review `gpt-6-sol` / low. Track each new agent/task in `agents.md`. Preserve this directory and its artifacts. Do not push or merge as complete until the final review and desktop/mobile manual E2E gates are clean.

This SDD path remains covered by `.gitignore`. Existing handoff artifacts are force-added for this push; force-add any new artifact files you want to preserve in a later commit.
