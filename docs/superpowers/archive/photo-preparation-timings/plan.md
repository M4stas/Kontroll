# Roadmap checkpoint 1: photo preparation timings

Authorized October 10, 2026. Stop after this checkpoint; later roadmap checkpoints require separate approval.

Authority: [roadmap](../../roadmap.md), [diagnostics design](../../specs/2026-10-09-live-diagnostics-design.md), and [agent policy](../../../agent-policy.md).

## Outcome and constraints

Add best-effort, lease-owned photo preparation telemetry to private report diagnostics. Keep model settings, prompts, input bytes, concurrency, retry scheduling, durable review records, and publication behavior unchanged. No extraction-service changes, PDF request telemetry, offline feature, historical-run picker, or export.

The feature flag remains server-only `LIVE_DIAGNOSTICS_ENABLED`, default false, and controls collection as well as exposure. Responses stay private/no-store behind existing report access. Timing records must contain only finite phases/states/error codes and IDs/timestamps/durations, never URLs, storage keys, raw errors, prompts, or document contents. Additive migration with RLS, server-only RPC permissions, current-run/job/worker/lease-attempt checks, bounded rows, parent/evidence ownership, and cascade cleanup. Preserve existing data.

Record UTC starts and monotonic completed durations. Separate queue wait/retry delay from measured work. Do not sum overlapping work or parent/child durations. Historical/unavailable/partial telemetry remains explicit. Reused photo preparation must not be represented as new work. Show actual phases: existing upload normalization must not be falsely labelled a resize if no resize occurs. Reviewer PNG resize/preparation is a distinct phase.

## Overhead acceptance

Run at least five paired deterministic four-photo application journeys, alternating enabled/disabled order, with identical generated photos and fake reviewer delays. Each enabled journey must add at most **500 ms** wall time relative to its paired disabled journey, and must have identical provider-call count and publication outcome. Record every pair, maximum, and raw results. This budget applies to each current/future diagnostics checkpoint until explicitly revised. Real external model latency is excluded from this overhead experiment. Do not submit live listings or make extra model calls for benchmarks.

Diagnostic I/O never runs on the measured phase's critical path. Use bounded pending writes and cancellation/timeouts. Flush before releasing job ownership with a maximum **100 ms per job** wait. Collector outage must not change the original work's result/error. Record incomplete measurements when writes fail or cannot finish in budget.

## What you will see

Expand a photo in the report's Live diagnostics drawer. Read download, validation, normalization/upload and reviewer image retrieval/verification/PNG preparation durations, with queue/retry waits separate. Historical reports show Not recorded. English and Estonian, desktop and mobile, preserve existing drawer behavior.

## How to check

1. Apply the additive migration on a disposable local database for testing; preserve existing databases.
2. Enable diagnostics in both the application and worker. Start an isolated production app.
3. Open a newly processed photo report and expand a photo's preparation timings.
4. Open historical, reused, retried and collector-unavailable cases. Labels remain truthful.
5. Compare five controlled enabled/disabled journeys against the overhead acceptance above.
6. Verify private denial, disabled flag, English/Estonian, desktop/mobile, refresh and reconnect. Final user app acceptance remains pending until the user sees the result.

## Task 1: Implement photo timing storage, instrumentation, private projection and UI

Implement this checkpoint as an integrated slice using existing repository seams. Own production and relevant unit/integration tests; coordinator owns documentation, environment setup and final acceptance.

- Inspect `src/listings/photos.ts`, `src/server/storage/uploads.ts`, `src/analysis/pipeline.ts`, `src/analysis/review-coordinator.ts`, `src/insights/codex.ts`, `src/insights/provider.ts`, `scripts/worker.ts`, `src/diagnostics/{contracts,project}.ts`, `src/server/repositories/diagnostics.ts`, `src/features/diagnostics/`, messages and diagnostics tests.
- Add an additive Supabase diagnostic timing table/RPC and data-preserving rollback. Check service role only, active job ownership and attempt, current run, evidence identity and same-owner parent. Reject stale/cross-run writes and bound rows per attempt. Avoid changing immutable review inputs/results.
- Add recorder with bounded best-effort asynchronous writes, monotonic durations, finite phase/error contracts and 100 ms maximum job flush. Collection disabled means no diagnostic DB writes. Preserve original return values/errors, including outages and supersession.
- Instrument existing photo download/check/normalization/upload and reviewer retrieval/verification/PNG preparation at their actual boundaries, without changing image bytes or requesting new model calls. Context must be bound per worker job and per photo, safe under three concurrent image reviews. Queue and retry time must be separate or explicitly unavailable, not attributed to active work.
- Project at most 500 safe spans and 1 MiB payload. Missing timing source must not hide healthy review records. Mark omissions explicitly; preserve current history pagination and latest review state. Handle inherited/reused photo evidence and provenance without new-call durations.
- Extend existing drawer/review cards with nested timings and ET/EN copy. Allow expanding photo timings before findings exist. Historical reports say Not recorded. Reuse existing visual styles and keyboard/mobile behavior; no redesign.
- Use meaningful red/green unit and integration regressions for actual duration boundaries, ordering/overlap, original error/value preservation, stale leases/ownership/privacy, historical/unavailable cases, and frontend labels. Read installed Next docs before framework edits.
- Do not edit documentation, agent policy, package dependencies, Python extraction code or unrelated features. Do not run integration tests against shared Supabase. Do not start provider calls or consume real queues. Do not spawn subagents. Commit only your own explicit files after focused tests pass. Write report to `.superpowers/sdd/2026-10-10-photo-preparation-timings/task-1-report.md` with changes, red/green evidence, commands/results, commits and concerns.

## Task 2: Verify acceptance with disposable data and production browser

Coordinator prepares isolated Supabase and synthetic report fixtures. Run isolated database integration gates, paired overhead experiment, unit/static/build gates, and manual EN/ET desktop/mobile checks. Obtain task-scoped and independent final migration/privacy/concurrency review; fix all material findings and repeat affected checks. Preserve evidence without private contents or credentials.

## Task 3: Deliver checkpoint PR and runnable demo

Record acceptance evidence and exact limitations, update roadmap status to implementation delivered/user acceptance pending, create and attach a scoped PR, and supply visible app check steps. Do not merge, deploy production, or begin roadmap checkpoint 2.
