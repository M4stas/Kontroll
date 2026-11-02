# Checkpoints 10 to 12 completion audit

Reviewed on 2026-11-02. Implementation is present for all three checkpoints, but none has enough evidence for full checkpoint signoff.

## Revisions and delivery state

| Checkpoint | Implementation | Delivery state | Remaining evidence |
| --- | --- | --- | --- |
| 10, S3 B | Registration and VIN polling, the identity deadline, report gating and report facts are implemented | [PR #52](https://github.com/M4stas/kontroll/pull/52) merged | Successful live identity reveal, comparison with the listing, and identity values in the report |
| 11, S4 B | Background-check scheduling, progress, protected PDF access, reuse and missing-result states are implemented | [PR #57](https://github.com/M4stas/kontroll/pull/57) merged | The complete live app checklist, including matching PDF, reuse, worker timeout, legacy reports and responsive/theme checks |
| 12, S4 C | Final-pass deferral, fetched PDF input, reuse, reconciliation, deterministic VIN mismatch findings and missing-PDF reasons are implemented on the branch | Pushed on `codex/background-check-findings`; GitHub returned no PR | PR and merge, required database/concurrency checks, full independent delivery review and the live app checklist |

Main revision was `08a6f033eff7ab756c7dcef708109fd4dfa340cc`. Checkpoint 12 was reviewed and tested at `1c2348d3dfe83f7215ca05ca309da39cc87d1565`. The working tree was not switched or merged.

The historical PR bodies record clean independent reviews and synthetic browser checks for checkpoints 10 and 11. Both explicitly say no live app lookup ran. The current PR API returned empty check rollups and formal review lists, so this audit does not infer CI signoff from the merge alone.

## Fresh automated checks

All repository code ran in disposable containers. Test containers had no network or credentials, read-only source and dependency inputs, a private process namespace and a read-only root filesystem. Installed dependencies were copied into a disposable Linux dependency volume and supplied with matching Linux native packages.

| Revision | Check | Result | Limit |
| --- | --- | --- | --- |
| Main | Focused tests for identity, report gating, pipeline, review coordinator, background-check stage, repositories, report UI, PDF access, worker runtime and uploads | 15 files, 277 tests passed | Focused unit tests, not the full CI or database integration suite |
| Checkpoint 12 branch | The same areas plus deterministic background-check findings | 16 files, 343 tests passed | No new SQL migration, rollback or integration test execution |
| Main | `pnpm build`, including service worker, production compilation, TypeScript and page generation | Passed | Build of main only |
| Current roadmap | `pnpm roadmap:status` | Completed against captured GitHub responses; checkpoint 12 has no PR | GitHub responses were captured outside the network-disabled container. Its source snapshot has no local Git branches |

Test commands used `pnpm --config.verifyDepsBeforeRun=false test --configLoader native --maxWorkers=2` with explicit test file paths. The native config loader kept dependencies read-only. A report-view test emitted next-intl's timezone fallback warning; all assertions passed.

## Browser evidence on main

The production server started with `pnpm start` and opened successfully in the internal browser at `http://localhost:3000/en`. The app container has an internal network. A separate relay exposes only the frontend on host loopback and forwards its local Supabase and extraction-service requests. Build font downloads use an allowlist for Google's two font hosts.

A live capture of the listing linked from the local development guide, Auto24 listing 4344096, showed:

1. The listing page appeared while the registration number and VIN were still marked "Looking up".
2. The inspection-report button stayed disabled with the waiting message while those values were pending.
3. Both identity rows settled as "Not found".
4. The inspection-report button enabled after they settled.
5. Switching to Estonian showed "Ei leitud" for both identity rows and an enabled report button.

This establishes the pending and missing-identity UI flow. It does not establish a successful reveal or matching report facts. Registration numbers and VINs were kept out of the audit output.

The preview starts the frontend only. The configured Codex analysis worker was not started or authenticated in this sandbox, and no model account credentials were supplied. The end-to-end report/PDF checklist remains open.

The running preview uses containers `cars-cp-app` and `cars-cp-app-relay`, with dependency volume `cars-cp-linux-deps`. Finished unit-test containers were removed after their logs were saved. The shared Supabase and Auto24 containers were left running.

## Independent static review of checkpoint 12

A fresh reviewer checked the branch against Tasks 11 to 13 in the [background check plan](../plans/2026-10-22-transpordiamet-background-check.md#checkpoint-12-background-check-in-the-findings). The bounded static review found no substantive implementation blocker. It confirmed source and test coverage for:

- Final-assessment deferral and cancellation of superseded review work.
- Durable fetched-PDF reconciliation, manual PDF coexistence and later-run reuse.
- Deterministic bilingual VIN mismatch findings with both sources.
- Missing-PDF reasons, protected source links and fetch dates.
- Tests for arrival-order and stale-publication races.

That review did not execute tests. The separate passing test runs above supply the fresh unit-test evidence. Static inspection and unit tests do not replace the database, live lookup or manual report checks.

## Roadmap decision

Keep checkpoints 10 and 11 as verification work. Keep checkpoint 12 as implemented on an unmerged branch, pending delivery and verification. Retain completed implementation in the [completed work log](../completed-work.md); no additional checkpoint is signed off by this audit.
