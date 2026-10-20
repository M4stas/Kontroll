# Auto24 capture timings checkpoint

Roadmap checkpoint 7. Plan: [Auto24 capture timings](../plans/2026-10-13-auto24-capture-timings.md).

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
| `python -m pytest -q` | 180 passed |
| `pnpm test` | 903 passed |
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

## Running app

Pending.
