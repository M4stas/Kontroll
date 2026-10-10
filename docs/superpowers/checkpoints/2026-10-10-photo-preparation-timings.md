# Roadmap checkpoint 1: photo preparation timings

Status: implementation and acceptance checks in progress. User app acceptance remains pending.

Baseline: `132d0f7612becd7c07e8e59f2e75a12ea876d73e` (merged main).
Authority: [roadmap](../roadmap.md), [scoped plan and overhead budget](../plans/2026-10-10-photo-preparation-timings.md).

## Scope

Private report diagnostics gain photo preparation timings. Capture preparation measures download, validation, metadata normalization and upload. Reviewer preparation measures the existing retrieval, verification and PNG preparation boundaries. No changes to model settings, image bytes, concurrency, retries or report publication are intended. Auto24 extraction timings, PDF diagnostics, offline viewing, history and export remain separate checkpoints.

Queue and retry waits must remain separate from active work, with explicit unavailable labels where timestamps do not support a measurement. Historical and reused records must not imply new work.

## Acceptance environment

Disposable Supabase project `photo-preparation-cp1` uses API 56321 and DB 56322. Existing stacks and queues remain unchanged. Generated photos, isolated storage, the real application pipeline and a fake reviewer command provide deterministic acceptance data. No live listing or external model calls are needed for the overhead experiment.

The temporary Supabase configuration and private demo environment are excluded from the PR. No credentials, report access tokens, signed URLs or private contents belong in this evidence.

## Verification

Before implementation:

- Unit baseline: 600 tests passed across 62 files.
- Disposable database baseline: 90 integration tests passed across 9 files.
- The additive timing migration applied successfully to the disposable database.

Rollback preservation passed: the rollback removed the timing RPC without changing 5 analyses, 31 evidence rows, 36 review executions, 31 review attempts or 84 timing rows. Restoring the RPC succeeded.

## Controlled overhead

Five alternating pairs used four generated 800×600 JPEGs, real capture preparation/storage and real private reviewer retrieval/type verification/PNG preparation. Only photo download bytes and the reviewer command were fixture-controlled. The fake command waited 30 ms before writing a valid result. Each pair made six fake reviewer commands (text, four photos, final), reached identical complete publication/verdict, committed its final result, and settled its own job queue. Disabled collection wrote zero spans. Enabled collection recorded all seven measured child phases for all four photos.

| Pair | Order | Disabled (ms) | Enabled (ms) | Added (ms) |
| --- | --- | ---: | ---: | ---: |
| 1 | Disabled, enabled | 784.90 | 659.30 | -125.60 |
| 2 | Enabled, disabled | 600.13 | 691.68 | 91.55 |
| 3 | Disabled, enabled | 565.11 | 488.62 | -76.48 |
| 4 | Enabled, disabled | 505.70 | 496.62 | -9.08 |
| 5 | Disabled, enabled | 571.03 | 527.06 | -43.97 |

Maximum added time was **91.55 ms**, below the **500 ms** per-pair limit. Negative differences reflect timing variability, not a speedup claim. These controlled results exclude external provider latency and are not production performance guarantees. [Raw safe results](photo-preparation-timings/overhead.json).

## Known measurement limits

Queue/retry waits are explicitly unavailable and never charged to active phases. A complete collector outage cannot persist its own failure; when no records survive, a later successful read says Not recorded. Recoverable losses persist omission/incomplete indicators. Timing-source read failure says Unavailable while healthy review cards remain visible. OpenAI remote image processing has no local PNG measurements. Reused preparation is not copied as new work.

Current gates: 614 unit tests across 64 files and 95 integration tests across 10 files passed. Lint and typecheck passed. The production build passed before the storage-error fix; a final build will include that fix.

Independent task review found a storage failure could be labelled complete because Supabase resolved an error object. Moving the existing throw inside the measurement fixed the label while preserving the original error and cause. Its red/green regression passed with 20 focused tests, and scoped re-review was clean. A proposed capture fallback finding was withdrawn after verifying that production capture snapshots are persisted atomically before worker preparation.

EN desktop checks passed for current, historical and reused reports; Escape returned focus to the diagnostics trigger. Short phases show milliseconds rather than rounded zero seconds. CUA displayed the screenshot inline; its documented API does not save screenshot files or expose browser console logs. Mobile, timing-source outage, reconnect, pre-result visibility and final branch review are still in progress.

One broad run overlapped build/test work and the worker CLI startup test hit its 10-second deadline. The subsequent complete unit run passed. An earlier integration run overlapped a focused database test and failed two empty-queue fairness assertions; serialized integration passed. The authenticated privacy fixture also needed a valid local JWT because email login is disabled. No test timeouts or production behavior were changed to resolve these setup issues.

## Delivery

A scoped PR and runnable demo are required. User acceptance remains pending until the user checks the app. This checkpoint does not authorize roadmap checkpoint 2.
