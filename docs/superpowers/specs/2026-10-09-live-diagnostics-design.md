# Live diagnostics side panel

Status: the original live review panel shipped in PR #14. Roadmap checkpoint 1 (photo preparation timings) authorized October 10, 2026. Later roadmap checkpoints remain separately gated. The [roadmap](../roadmap.md) and scoped [photo preparation plan](../plans/2026-10-10-photo-preparation-timings.md) supersede the original combined checkpoint numbering below. User selected the side panel.

## Outcome

Expose live capture and review progress, saved intermediate results, and timings beside the listing dashboard and private report. A developer can identify where one listing spends time without reading terminal logs. Keep ordinary report rendering and reviewer behavior unchanged.

Implementation baseline: `main` after PR #13 (concurrent photo review and PDF-only final-review reuse). Recheck the baseline at execution time. Follow [agent policy](../../agent-policy.md) for any implementation, testing, or review delegation. Policy files are read-only.

## Scope and defaults

- Enable with an explicit server-only `LIVE_DIAGNOSTICS_ENABLED=true` setting; default false. Ship initially for local development. The flag is not authentication: every request still requires the existing listing/report cookie.
- Put a Live diagnostics button on both the listing dashboard and report, so capture is observable before a report exists. On desktop it opens a right-side drawer; on mobile a full-screen sheet. Preserve the page, scroll position, and open details while polling. Support Escape, focus return, keyboard navigation, and English/Estonian labels.
- Default to the current report run; allow selecting earlier runs. State explicitly when an earlier result was reused, which run supplied it, and when it originally completed. Do not display reused results as new model calls or calculate negative durations from their execution creation timestamps.
- Deliver timing, intermediate results, and JSON export in the first release. Historical comparisons across listings, automated optimization advice, account-wide monitoring, raw log viewers, CPU graphs, token/cost tracking, and changes to review settings are outside this release.

## Checkpoint delivery

The first release is delivered through three independently demonstrable checkpoints, detailed in the [implementation plan](../plans/2026-10-09-live-diagnostics.md):

1. **Live review panel:** report drawer, live text/photo/final status and attempt timings, committed intermediate results, retry/reuse labels. Reuse existing records; no timing migrations or extraction changes required. Demo a four-photo review and inspect results as each finishes.
2. **Detailed capture timings:** Auto24/dashboard visibility, capture-to-report provenance, additive timing storage, extraction/application/photo-preparation instrumentation, and nested phase timings. Demo the measured cause of a wait and a recoverable measurement failure.
3. **Complete diagnostic workflow:** PDF processing and reassessment view, previous/current results, earlier-run selection, and timing-only export. Demo a PDF-only update and export a complete session.

Each checkpoint requires its own attached PR, clean independent subagent review, relevant automated checks, and clean desktop/mobile English/Estonian manual E2E with visible demo evidence. Access checks, trustworthy state labels, and existing review behavior are required from checkpoint 1. Full release acceptance below applies after checkpoint 3; later features do not block earlier checkpoints. Only roadmap checkpoint 1 photo preparation instrumentation is currently authorized for the next implementation. Extraction, PDF diagnostics, history and export remain separate work.

## Panel contents

1. Summary: capture elapsed time, current-run elapsed time, current activity, selected/reviewed/running/waiting/unavailable/skipped image counts, retries, last successful refresh, and connection/stale state.
2. Timeline: extraction queue and capture; application queue and photo preparation; text review; individual image reviews; final assessment; saved report. Include baseline/research/assembly jobs as secondary rows when present. Distinguish job completion from a final published report and optional unavailable research from failed required work.
3. Review cards: text and final cards plus image cards in manifest order. Each shows state, attempt history, running elapsed time or completed duration, configured model/effort, and sanitized warning codes. Images use the existing authenticated analysis-owned image route, with lazy-loaded thumbnails.
4. Result details: render only committed, schema-validated results. Show title, explanation, severity, confidence, source references, and recommended action. Label intermediate findings as provisional until final assessment completes. Show an explicit zero-observations state. Never expose provider reasoning, prompts, credentials, signed URLs, storage keys, or raw provider output.
5. Auto24 details: queue wait; browser startup; browser context/page setup; navigation including permitted redirects; HTML retrieval; response/page validation; listing parsing; browser shutdown; result persistence. Show failures and retry waits by capture attempt. There is no separate selector-readiness wait in the inspected scraper; do not invent one.
6. Photo preparation: per-photo download, validation, image normalization, private upload, and total. Separately show reviewer-side private-image retrieval/verification and PNG preparation before the provider call. Keep those costs distinct from the Auto24 scraper, which returns photo URLs rather than downloading these images.
7. PDF update: distinguish upload processing/text extraction from the final review, show earlier text/image reviews reused, and display the new final result. A raw comparison of previous/current final observations is enough for version one; semantic added/changed/removed labels are deferred because model-generated observation IDs are not stable across runs.
8. Export: one versioned JSON download containing the authorized job/run identifiers, stage/attempt timings, counts, model settings, and safe warning codes. Exclude findings text, document text, photos, raw URLs, credentials, and infrastructure details. Export includes the measurement-availability flags and observation timestamp.

## Timing semantics

- Capture service submission-to-result and application-run start-to-publication are separate totals. They describe different clocks and boundaries; neither includes user dwell time between dashboard capture and starting a report. Do not label their sum as total user wait.
- Use persisted UTC timestamps for ordering and live elapsed clocks; return `serverNow` for client clock offset. Use monotonic clocks within each process for completed phase duration. Never subtract monotonic values from different processes.
- Review attempt elapsed time already exists as `review_attempts.started_at` to `completed_at`. It includes adapter preparation and persistence overhead; label it attempt duration, not pure provider latency. New adapter spans separate preparation and provider invocation.
- Parallel image durations overlap. Image-phase wall time is earliest current-run image-attempt start to latest finish, with active time continuing from serverNow. Sum of attempt work is a separately labelled metric, never report latency.
- Queue wait, active work, and retry delay remain separate. Child spans nest under parents and are not added to parent durations. Partial spans are marked incomplete; historical missing measurements read Not recorded, never zero.
- No percentage within a model call, invented ETA, or universal slow threshold. Sort completed stages/photos by duration and show measured waits. A long running call is still running if its worker lease is live; lease expiry makes it stale, not automatically failed.

## Data and access architecture

Reuse `review_executions`, `review_attempts`, `review_run_snapshots`, job statuses, and the current result publication barrier. Do not modify immutable review inputs or results to add telemetry.

Add small dedicated timing tables: Supabase `diagnostic_spans` for application phases, and Turso `diagnostic_spans` for extraction phases. Rows contain an opaque span ID, parent ID, phase enum, owning job/run/attempt identifiers, optional evidence ID, UTC start/end, monotonic duration in milliseconds, state, and an allowlisted error code. No arbitrary metadata/text field. Index by owner and start time. Supabase has RLS and no browser-role access; only server/worker reads and lease-checked writes. Turso remains owned exclusively by the storage service.

Start/finish writes for extraction go through authenticated internal storage routes and validate the active lease token. Application spans go through dedicated lease-checked RPCs. Diagnostic writes are separate from review transactions and never renew leases or change job status. Observers are best effort with short deadlines: telemetry failure cannot fail or delay a successful review indefinitely. Surface missing/incomplete timing as a measurement gap. Maintain a bounded pending-write queue, drain outside the measured phase, and await a bounded flush before releasing ownership; reject late stale-worker writes.

Two ownership exceptions need explicit storage boundaries: measure extraction result persistence inside the storage completion operation, without a late worker write after completion; collect PDF processing in bounded request-local memory, then attach it to the accepted submission/run using a server-only submission-ownership RPC. Never trust client timing values or create a run for a rejected upload. These exceptions do not grant workers post-lease writes.

Link extraction to reports using existing `analysis_inputs.service_job_id`, resolved server-side after analysis access verification. Do not accept a client-supplied unrelated capture ID. For the listing dashboard use its existing job-cookie verification. Manual reports show extraction Not applicable. Capture refreshes retain provenance; label original capture separately when the run uses pasted replacement text.

New read endpoints:

- `GET /api/listings/[jobId]/diagnostics`: listing cookie, feature gate, safe extraction snapshot.
- `GET /api/analyses/[publicId]/diagnostics?runId=<uuid>`: report cookie, analysis/run membership verification, projected audit records plus application spans and linked extraction measurements. Default current run. Return a bounded run list and timing payload; no unrestricted table selection.
- `GET /api/analyses/[publicId]/diagnostics/results?runId=<uuid>&executionId=<uuid>`: same access checks, lazy retrieval of one validated committed result belonging to that analysis/run. Failed/in-progress attempts return state without partial output.
- Private extraction `GET /v1/jobs/[jobId]/diagnostics`: existing API-key protection; its response never contains lease tokens. Next.js proxies it after browser access validation. Storage read/write routes use the internal key; no new host port.

Every browser-facing response uses `Cache-Control: private, no-store`. Feature-disabled endpoints return 404. Missing access returns 401; mismatched run/execution returns 404. An unavailable telemetry source returns a partial response with explicit availability; it does not hide healthy review data. Safe error responses omit database and provider internals.

Poll at most once every three seconds while the drawer is open and the document is visible, with one in-flight request. Pause when hidden/closed; refresh immediately on reopen/focus. Back off transient failures to 6, 12, then 30 seconds; allow Retry now. Abort outdated requests and key state by analysis/run/job. Continue lightweight discovery after completion while open to detect PDF/supplement runs. Detailed result fetches occur only when expanded and are cached by immutable execution/result identity. No WebSocket/SSE dependency.

Bound each timing response to 500 spans and a 1 MiB serialized budget. Paginate older runs/attempts/spans with an explicit cursor and truncation indicator; never silently omit them or truncate observation text. Restrict phase names and error codes to finite schemas. Keep telemetry for the same lifetime as its owning local job/analysis, with cascade cleanup; no scheduled global retention job in version one.

## Compatibility and deployment

Migrations are additive. Preserve all current reports, review attempts, private objects, Turso jobs, and queue state. Support old services that return no diagnostic measurements and historical reports without spans. Rollback disables the flag and restores application/service code; additive tables can remain. Never reset databases to test migrations. Test with disposable local stacks. Production exposure requires a separate explicit decision about developer-only authorization.

## Acceptance

- An authorized live listing shows extraction phases before the report is created; the report retains their provenance afterward.
- A controlled four-image run shows at most three running images, manifest order, and saved findings appearing independently as each result commits. Final review starts only after its existing barrier.
- Accurate text/image/final attempt durations, nested phase measurements, queue waits, retry attempts, and reused results remain correct after refresh and worker restart.
- A PDF-only update shows reused text/images and exactly one new final assessment without stale previous-run results being labelled current.
- Offline, expired lease, superseded run, failed photo, unavailable telemetry, historical/no-measurement, and feature-disabled states are truthful and usable.
- Cross-analysis/job/run/execution reads fail. No secrets, storage capabilities, prompts, or document text appear in timing payloads/export. Intermediate results remain behind report access.
- Timing collection does not change reviewer selection, prompts, reasoning effort, photo limits, concurrency, retries, publication behavior, or verdict policy.
- Independent subagent review is clean, desktop/mobile English/Estonian manual E2E is clean, and an attached PR exists before implementation is declared complete.

## Chosen tradeoff

Reuse existing polling and audit records, add focused timing records, and expose them through a drawer. This is less code and easier to maintain than a separate monitoring dashboard or streaming subsystem. An expanded progress section would take fewer UI lines but would crowd the report and cannot replace the missing phase instrumentation.
