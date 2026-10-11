# Roadmap checkpoint 1: photo preparation timings

Status: implementation delivered for review; user app acceptance remains pending.

Baseline: `132d0f7612becd7c07e8e59f2e75a12ea876d73e` (merged main).
Authority: [roadmap](../../roadmap.md), [scoped plan and overhead budget](plan.md).

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

Maximum added time in the first run was **91.55 ms**, below the **500 ms** per-pair limit. Negative differences reflect timing variability, not a speedup claim. These controlled results exclude external provider latency and are not production performance guarantees. [Raw safe results](overhead.json).

After the upload-error fix, five further alternating pairs on `be4bab1` passed. Added times were -252.46, -31.10, -33.01, -12.43 and 10.38 ms, maximum **10.38 ms**, with identical six commands and final outcomes. All ten recorded pairs passed the same 500 ms budget. [Final-code raw results](overhead-final.json).

## Known measurement limits

Queue/retry waits are explicitly unavailable and never charged to active phases. A complete collector outage cannot persist its own failure; when no records survive, a later successful read says Not recorded. Recoverable losses persist omission/incomplete indicators. Timing-source read failure says Unavailable while healthy review cards remain visible. OpenAI remote image processing has no local PNG measurements. Reused preparation is not copied as new work.

Current gates: 614 unit tests across 64 files and 95 integration tests across 10 files passed. Lint and typecheck passed. The final production build passed after the storage-error fix.

Independent task review found a storage failure could be labelled complete because Supabase resolved an error object. Moving the existing throw inside the measurement fixed the label while preserving the original error and cause. Its red/green regression passed with 20 focused tests, and scoped re-review was clean. A proposed capture fallback finding was withdrawn after verifying that production capture snapshots are persisted atomically before worker preparation.

EN desktop checks passed for current, historical and reused reports; Escape returned focus to the diagnostics trigger. Short phases show milliseconds rather than rounded zero seconds. Coordinator browser verification also passed English and Estonian at a measured 390×844 CSS viewport, with no horizontal drawer overflow. The timing-source outage test temporarily revoked SELECT only on the disposable telemetry table: the drawer said Unavailable while all four completed reviews stayed visible, then recovered to Available after SELECT was restored. A local proxy returned diagnostic 503 responses: expanded timings stayed visible with a connection-loss label and recovered after Retry now. Disabled production omitted the diagnostics trigger. Actual endpoint checks returned 401 without access, 404 with the flag disabled, and 200 with valid access; all were private/no-store.

A held real preparation fixture showed 0/4 photo results, three running and one waiting, with completed capture and reviewer phase timings expandable before findings existed. Releasing the fake reviewer gate settled the report successfully. This proves preparation duration excludes the held provider wait.

CUA displayed screenshots inline. The browser surface offers no documented screenshot file-save method; screenshot files are therefore not attached. Coordinator browser console checks for current EN/ET views contained no warning/error entries. The narrow manual-test agent checked EN desktop and historical/reuse; coordinator completed responsive, outage, disabled and reconnect checks after recovering browser access.

Independent whole-branch migration/privacy/concurrency review of `132d0f7..8288cc3` was clean, with no Critical or Important findings.

One broad run overlapped build/test work and the worker CLI startup test hit its 10-second deadline. The subsequent complete unit run passed. An earlier integration run overlapped a focused database test and failed two empty-queue fairness assertions; serialized integration passed. The authenticated privacy fixture also needed a valid local JWT because email login is disabled. No test timeouts or production behavior were changed to resolve these setup issues.

## Delivery

Draft PR: [#22](https://github.com/M4stas/kontroll/pull/22). The isolated production demo runs at `http://localhost:3061`; generated fixture reports and subsequent real-listing E2E reports are available locally. Apply the additive migration before enabling diagnostics in application and worker. Leave the flag false to disable collection and exposure; the rollback removes the RPC while preserving data.

Manual desktop interaction used the in-app browser panel (538 CSS pixels wide); EN/ET mobile checks verified a 390×844 CSS viewport. The initial run could not establish a wide desktop viewport. A subsequent native Brave desktop E2E passed, as recorded below; user acceptance remains pending. Screenshots were displayed inline rather than saved as files.

User acceptance remains pending until the user checks the app. This checkpoint does not authorize roadmap checkpoint 2.

## Real-listing E2E — 11 October 2026

The coordinator submitted public Auto24 listing 4352399 through the in-app browser and then through native Brave, using the isolated checkpoint database and the configured live Codex gpt-6-luna reviewer. Each worker was restricted to its single report; external model review was explicitly approved by the user. No product code changed.

Both runs captured BMW 320 Touring, 2012, EUR 4,800, 260,300 km and 26 photos. All 24 selected photos completed; two were skipped by the existing limit, with zero unavailable. Text review, photo review and final assessment completed and published a report. Reload retained findings and photo timings. In-app browser warning/error logs were empty; native Brave console logs were not inspected.

Brave desktop checks passed for submission, automatic progress, final publication, rendered photo evidence, diagnostics expansion, Escape/focus return and reload persistence. Capture phases appeared before findings; reviewer retrieval and PNG phases appeared after preparation. Photo 1 retained these values after reload: capture 867 ms, download 752 ms, validation 7 ms, normalization 36 ms, upload 67 ms, stored access 168 ms, reviewer preparation 487 ms, private retrieval 183 ms, PNG preparation 304 ms and type verification below 1 ms. Native screenshots showed the wide desktop layout without visible clipping and were displayed inline.

Local reports: in-app browser `/en/r/90aa4ec8-29b9-4c40-9e28-5cd8d57f199a`; Brave `/en/r/70b472dd-b5b0-4b8d-8361-eab26bed0541`. Access credentials are not included in this evidence. Both scoped test workers were stopped after completion.
