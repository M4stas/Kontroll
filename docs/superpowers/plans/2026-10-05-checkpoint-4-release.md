# Checkpoint 4 release plan

**Goal:** Deliver a reviewed release candidate for the current online report.

**Scope:** User confirmed on October 5 that offline saving and the persistent viewing checklist are deferred. Validate existing online behavior. No new AI subsystem or external source integration.

**Baseline:** Checkpoint 3 local commit `242e34a`; PR 9 merged into main at `1290cf7`. Preserve local preview files in the checkpoint 3 worktree. Agent allocations follow [the read-only policy](../../agent-policy.md).

- [x] Create isolated release worktree and inspect merged baseline.
- [x] Audit existing application, acceptance scope, and dependencies.
- [x] Translate new report interface controls without changing saved report content.
- [x] Apply compatible dependency patches and verify runtime audit.
- [x] Run all unit and integration tests, lint, typecheck, build, and diff checks.
- [x] Run integrations against a disposable Supabase instance with no live jobs.
- [x] Manually verify a real Auto24 journey in the in-app browser and Brave, desktop and mobile.
- [x] Verify private denial, refresh, evidence, English UI and automated ET copy, seller-message copy, and same-report supplement update.
- [x] Fix every release defect and rerun its affected checks.
- [x] Obtain a clean independent source review. Final delivery docs review follows.
- [x] Record exact revision, test results, demo evidence, and limitations in the release ledger.
- [x] Create and attach the checkpoint 4 PR.

Primary files: existing report components and messages for translation defects; `package.json` and lockfile for compatible dependency patches; `README.md` and `docs/superpowers/checkpoints/checkpoint-4-release.md` for operational and acceptance evidence. No changes to `docs/agent-policy.md`.

The shared development database contains older queued jobs. Its global fairness checks require an empty queue. Use a separate Supabase project and alternate local ports; do not clear the user's database to obtain a pass. Restore temporary Supabase configuration before delivery.

## Tracking requested by the user

Remaining-work estimates start at 2026-10-05 20:45 UTC, 23:45 Tallinn time.

| Point | Remaining minutes | Added nonblank LOC |
|---|---:|---:|
| Automated tests, TypeScript, lint, build | 15–25 | 0–40 |
| Manual desktop/mobile online checks | 20–35 | 0–40 |
| Real Auto24 journey | 15–30 | 0–20 |
| Fixes, independent review, docs, PR | 20–40 | 200–350 |

The points overlap; overall estimate is 45–70 minutes. LOC excludes the lockfile, generated files, temporary database configuration, and screenshots. Repairs are allocated to the final point, avoiding double-counting. Notify the user when a point completes and when its upper time or LOC estimate is exceeded. English-only manual testing follows the user's earlier instruction; ET controls receive automated regressions. Offline saving and persistent checklist are deferred by the user's explicit answer.

### October 7 resumption

The session resumed after services had stopped. Original time limits for manual
acceptance and release preparation elapsed before delivery. The 350-line repair
estimate was exceeded at about 365 added nonblank lines, already reported.
Revised remaining estimates start at 11:26 UTC, 14:26 Tallinn on October 7:
15–30 minutes for debugging and automated checks, 10–20 minutes for final manual
retesting, and 10–15 minutes for review, documentation, and the PR. Work overlaps;
the overall remaining estimate is 30–50 minutes and another 30–80 lines.
