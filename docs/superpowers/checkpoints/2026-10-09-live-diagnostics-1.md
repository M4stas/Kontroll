# Live diagnostics checkpoint 1

PR: [#14](https://github.com/M4stas/kontroll/pull/14).

Implementation base: `2ef6c2c79921f7072a50fd45f322fe3d8d9219df`.
PR #13 supplied durable concurrent photo review and merged during checkpoint verification.
Checkpoint 1 targets main. No new migrations or runtime dependencies.

## Delivered behavior

Private reports expose a server-gated diagnostics drawer. It reads existing
snapshots, executions, attempts, and jobs. Text, manifest-ordered photo, and final
cards show safe pinned settings, current state, attempt history, and attempt
duration. Expanded cards load committed, validated, sanitized findings and
analysis-owned thumbnails. Zero observations and provisional findings are explicit.

The drawer polls every three seconds while open and visible, with one request
in flight, cancellation, transient-error backoff, and Retry now. Completion does
not stop current-run discovery. Older attempt pages do not change the current
attempt's state or duration. New runs discard old-run results. Reused reviews
show their source run and original completion time without a new-call duration.

The server flag defaults false. Disabled endpoints return 404; missing report
access returns 401. Responses use `Cache-Control: private, no-store`. Cross-run
and cross-execution access is denied. Timing payloads omit prompts, inputs,
storage keys, capabilities, and raw errors. Findings are sanitized and validated
before being returned. No worker or publication-barrier behavior changed.

## Controlled demo

A disposable Supabase project used API 55321 and DB 55322, separate from the
existing development stack. Its schema applied all existing migrations. An
isolated app ran on 3051; a second production server on 3052 disabled diagnostics.
No live Auto24 request, external model call, or unrelated queue was used.

The browser submitted a synthetic manual report and four generated photo files.
The real coordinator used an injected fake reviewer with fixed image delays.

| Check | Observed result |
| --- | --- |
| Maximum simultaneous photo calls | 3 |
| Photo call durations in manifest order | 12.1s, 3.0s, 18.0s, 4.5s |
| Intermediate progress | 2/4 and 3/4 visible; final still waiting |
| Saved photo result before final | Expanded independently, labelled provisional |
| Photo order | Manifest order throughout out-of-order completion |
| Completed text/final durations | About 2.0s each |
| Zero observations | Explicit saved-result empty state |
| PDF-only update | Reused text and four photos; exactly one new final call |
| Reuse provenance | Original completion times; duration Not recorded; no negatives |
| Failed attempt | Timeout code, failed attempt history, retrying state |
| Expired lease | Explicit expired-lease label; recovery completed with attempt history retained |
| Offline/reconnect | Saved expanded details retained, last-refresh frozen; Retry now restored connection |
| Feature disabled | Button absent; endpoint 404 with private/no-store |
| Missing access | Endpoint 401 with private/no-store |

Attempt duration includes preparation and saving; these numbers are controlled
fixture measurements, not production provider latency or a performance claim.
Three concurrent calls were measured by the fake reviewer. Browser snapshots
also confirmed independent committed results while other images were active.

Desktop and mobile 390×844, English and Estonian, keyboard Escape/focus return,
refresh, preserved details, authenticated thumbnails, PDF discovery, retry,
stale lease, and offline/reconnect were checked manually. Saved conclusions
retain their run's original language when the interface locale changes.

## Verification

- Unit suite: 600 tests passed across 62 files (two workers), including the recovery fix below.
- Lint, typecheck, and `git diff --check` passed.
- Integration suite: 90 tests passed against the disposable stack.
- Production build passed.
- Python regression suite: 133 passed after installing its missing Camoufox prerequisite.
- Independent subagent review found result sanitization, latest-state pagination,
  and photo-thumbnail gaps. All were fixed; scoped re-review was clean.
- The existing worker CLI test timed out once under broad parallel machine load.
  Its focused retry and full suite with two workers passed.

## Demo images

- [Desktop drawer and saved result](live-diagnostics-1/diagnostics-desktop-et-details.jpg)
- [Mobile English](live-diagnostics-1/diagnostics-mobile-en.jpg)
- [Mobile Estonian](live-diagnostics-1/diagnostics-mobile-et.jpg)
- [PDF result reuse](live-diagnostics-1/diagnostics-pdf-reuse-en.jpg)
- [Offline](live-diagnostics-1/diagnostics-offline-en-production.jpg)
- [Reconnected](live-diagnostics-1/diagnostics-reconnected-en.jpg)
- [Retry history](live-diagnostics-1/diagnostics-retry-en.jpg)
- [Expired lease](live-diagnostics-1/diagnostics-stale-en.jpg)
- [Feature disabled](live-diagnostics-1/diagnostics-disabled.jpg)

## Remaining scope

Checkpoint 2 adds capture/dashboard visibility and detailed extraction/application
phase measurements. Checkpoint 3 adds PDF processing detail, earlier-run selection,
previous/current final comparisons, and timing-only JSON export. Internal phase
measurements remain Not recorded in checkpoint 1. Disable the flag to roll back
exposure; no data migration or database reset is needed.

## Findings recovery follow-up

Astra/high review found that a failed lazy findings request left its error visible
after a successful collapse/reopen fetch. Both accepted network results and cache
reads now clear that error within the existing cancellation guard.

The two new regression cases failed before the fix and passed afterward. All
600 unit tests, focused ESLint, TypeScript, and diff checks passed. Scoped
independent subagent review was clean.

Manual verification used the ChatGPT in-app browser and a separate production
build against the synthetic demo report. A temporary local proxy returned 503
for the first findings request and forwarded later requests. The browser showed
the failure, then showed No observations recorded after collapse/reopen, with
the error gone. A subsequent cached reopen also succeeded; the proxy recorded
only two findings requests. No live services, queues, or provider calls changed.

[Recovered findings screenshot](live-diagnostics-1/diagnostics-recovery-fixed.jpg).
