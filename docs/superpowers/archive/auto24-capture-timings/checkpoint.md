# Auto24 capture timings checkpoint

Roadmap checkpoint 7. Plan: [Auto24 capture timings](plan.md). PR: [#46](https://github.com/M4stas/kontroll/pull/46), merged on 2026-10-21 as `b61e319` and accepted by the user.

Base: `origin/main` at `3aefd14`, after the phone layouts in PR #33. No new runtime dependency. The Turso change is additive: a new `diagnostic_spans` table and a `diagnostic_omitted` column on `jobs`.

## Delivered behavior

- The extraction worker measures browser start, page setup, page load, HTML retrieval, page checks, parsing and browser shutdown. The storage service records queue waits, retry waits and saving the result.
- Span writes are checked against the active lease. A stale worker cannot overwrite the next attempt. At most 64 spans are kept per job, and the rest are counted as omitted.
- The listing page has Live diagnostics under the report button and on a failed capture. It works before the report exists and refreshes every 3 s while open and visible.
- The report drawer shows the same capture timings above the photo timings, linked through `analysis_inputs.service_job_id` on the server.
- Older listings show Not recorded. Pasted-text reports show that capture timings do not apply and make no service call.

## Automated checks

| Check | Result |
| --- | --- |
| `python -m pytest -q` | 185 passed |
| `pnpm test` | 904 passed |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed |

## Overhead

`python scripts/measure_capture_overhead.py` ran `worker.run_once` against an in-process storage service over HTTP. It used a fake browser capture with 1.0 s of fixed phase sleeps and the real parser on `tests/fixtures/auto24-passenger-car.html`. The limit is 500 ms added time per pair.

```
pair order             enabled ms disabled ms  diff ms spans same
   1 enabled first         1044.4      1029.8     14.6     9 yes
   2 disabled first        1038.9      1036.5      2.4     9 yes
   3 enabled first         1043.6      1031.9     11.7     9 yes
   4 disabled first        1058.0      1028.2     29.8     9 yes
   5 enabled first         1034.2      1037.4     -3.2     9 yes
max difference: 29.8 ms (limit 500 ms)
identical outcomes: yes
PASS
```

## Review

An independent review covered concurrency, privacy, the migration and the polling refactor. It found two problems in how missing spans were counted:

- Spans dropped at the 100 ms flush deadline were counted only inside the worker and never reached storage. The worker now sends its final count with `complete` or `fail`, and storage adds only the increase for that attempt.
- Storage counted each dropped write, so one lost phase counted twice. The worker counts the same way, so the count stays in writes, and the drawer now says how many timing updates were not saved.

## Running app

A separate Compose project, `auto24-timings`, ran on port 8010 with its own Turso volume and `LIVE_DIAGNOSTICS_ENABLED=true`. The app ran from this worktree on port 3007 in the built-in browser, with the report worker limited to new reports. The listing was https://www.auto24.ee/soidukid/4334166, chosen by the user.

| Check | Observed result |
| --- | --- |
| Drawer on the listing page right after submitting | Queue wait 933 ms, then browser start, page setup and a running page load appeared while the capture ran |
| Finished capture | All ten phases complete, including two page checks spans (before and after HTML retrieval) and saving the result |
| Report drawer | The same capture timings above the photo reviews |
| Worker paused for over 2 minutes during page load | Attempt 1 ends with page load marked incomplete. Attempt 2 starts with a 35.2 s queue wait from the lease end and completes all phases |
| Storage restarted with the flag off | The capture completed and the drawer said capture timings are off |
| A finished capture with no phases | Not recorded. This check found the drawer said "No capture phases recorded yet" for finished jobs; fixed in `92039e0` |
| Pasted-text report | Capture timings say not applicable |
| Missing or other-job cookie | `GET /api/listings/{jobId}/diagnostics` returned 401 with `Cache-Control: private, no-store` |
| Estonian at phone width | Trigger, drawer and phase names in Estonian. The drawer fills the screen |
| 1280×800 | Live diagnostics sits under the report actions; the report button stays in the first screen |
| Focus | Escape closes the drawer and returns focus to its trigger |

A second full run on 2026-10-21 repeated every check above. It also covered the app with `LIVE_DIAGNOSTICS_ENABLED=false`: neither the listing nor the report showed a Live diagnostics button, and both diagnostics endpoints returned 404 with `private, no-store`. The report's evidence-row trigger showed the same capture timings, with all 9 photos reviewed. The overhead script repeated with a maximum of 32.8 ms per pair.

Not checked in the running app: a listing that no longer exists, because no such link was available. Unit tests cover the failed capture section's trigger.

The model reviews retried on 2026-10-20 because the local Codex CLI failed at the time. On 2026-10-21 the same review inputs succeeded, and that path is unchanged by this checkpoint.

## After the merge

On merged `main` (`b61e319`) every suite passed: `pytest` 185, `pnpm test` 904, `pnpm test:integration` 86 against a disposable Supabase project, and `pnpm test:e2e` 2. Lint, typecheck and build passed. The integration suite first failed to load `diagnostics-access.test.ts`, because this checkpoint added `import "server-only"` to the diagnostics repository and only the unit config mapped that import to its test stub. The integration config now maps it too.
