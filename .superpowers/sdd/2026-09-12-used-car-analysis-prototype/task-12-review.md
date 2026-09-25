### Spec Compliance

Task 12 is not spec-compliant. The access-first route, limits, byte-level MIME validation, random analysis-scoped keys, EXIF stripping, stage mapping, service-role-only RPC, fixed `search_path`, and same-key database idempotency are present. However, accepted seller text, identity corrections, documents, and images are only stored in `submissions`; no analysis stage loads or uses them. The resulting rerun therefore cannot update its verdict from the new material. The rerun also fails to preserve run-scoped report data, distinct concurrent groups can create an unrunnable current run, and cleanup can delete objects after an ambiguously successful commit.

### Strengths

- `src/app/api/analyses/[publicId]/submissions/route.ts:75-98` checks the public capability before dependency construction, internal analysis lookup, or multipart parsing.
- `src/server/storage/uploads.ts:55-88` validates declared and detected MIME, enforces the per-file byte limit before and after image processing, strips metadata while applying orientation, and generates random analysis-scoped keys without using original filenames.
- `supabase/migrations/202609200001_atomic_supplement_submissions.sql:8-18,169-172` makes the acceptance RPC `security definer`, fixes `search_path`, revokes public/anonymous/authenticated execution, and grants only `service_role`.
- `supabase/migrations/202609200001_atomic_supplement_submissions.sql:29-55,114-165` serializes same-analysis acceptance, creates the run/submissions/jobs/current-run switch in one transaction, and returns the existing run for a repeated UUID.
- `src/app/api/analyses/[publicId]/submissions/route.ts:154-161` returns a private, generic response without storage keys, signed URLs, original filenames, or backend error details.
- `src/analysis/affected-stages.ts:8-15` matches the required stage sets exactly.
- `src/features/supplements/supplement-form.tsx:97-189` keeps the approved dark inspection-sheet direction and clearly labels supplied material as unverified.

### Issues

#### Critical

- `src/server/repositories/analyses.ts:265-303` — Accepted supplements are never loaded into `AnalysisRunContext`; repository search shows `submissions` is written but never read, while `src/analysis/pipeline.ts:189-215,312-330` continues to normalize, check, and enrich only the original captured snapshot/input. Impact: seller answers, uploaded documents/images, and VIN/plate corrections cannot affect evidence, identity, findings, or verdict, so the central Task 12 behavior is non-functional. Fix: load the accepted run's cumulative submissions into the run context, resolve private files through analysis-scoped signed reads, inject corrections before normalization, include seller text/documents/images in baseline/enrichment inputs as unverified material, and add pipeline-level tests proving each supplement kind changes the rerun output.

- `supabase/migrations/202609200001_atomic_supplement_submissions.sql:107-120` — The new run inherits only `stage_states`; it does not clone or otherwise inherit run-scoped `vehicle_facts`, `source_snapshots`, `evidence`, `findings`, or `actions`, while `src/server/repositories/analyses.ts:158-165` reads those tables exclusively by the new `current_run_id`. Impact: an image-only rerun can publish without the prior facts/sources/evidence, and even baseline reruns lose unchanged facts/snapshots, so the refreshed report drops existing analysis data instead of preserving it. Fix: atomically materialize all unaffected run-scoped artifacts into the new run (with valid remapped relationships), or implement explicit run ancestry/fallback reads and writes; test that every original report section remains present after each supplement kind.

- `supabase/migrations/202609200001_atomic_supplement_submissions.sql:29-55,107-155` — The row lock serializes distinct accepted groups but derives the second run from the currently selected run even when that run is still queued. Example: a seller-answer run removes `baseline_checks`; an immediately accepted image run inherits that missing state but queues only `enrich` and `assemble_report`, so assembly fails with `baseline_unavailable`. Impact: concurrent or rapid distinct submissions can supersede a valid queued run with an incomplete current run, while the first run's later publication is blocked by the current-run guard. Fix: define cumulative run lineage under the lock: carry forward all accepted submissions, invalidate the union of outstanding/affected stages, queue every missing prerequisite, and explicitly supersede obsolete jobs; add true concurrent tests for same and different UUIDs with different stage sets.

- `src/app/api/analyses/[publicId]/submissions/route.ts:145-161` — Any thrown RPC error triggers deletion of every object uploaded by the request, but an RPC can commit successfully and still fail at the client because the response was lost. Impact: cleanup can delete objects already referenced by an accepted submission, leaving durable rows and jobs pointing at missing private files; a same-key retry cannot repair those objects. Fix: treat transport/unknown persistence errors as indeterminate, reconcile acceptance by `(analysis_id, idempotency_key)` using a service-role helper, and delete only keys proven unreferenced by the accepted group; add a committed-but-response-lost regression test.

#### Important

- `src/app/api/analyses/[publicId]/submissions/route.ts:96-110` — `request.formData()` buffers/parses the complete multipart body before the eight-file and 12 MiB-per-file checks run. Impact: an authorized malformed request can send arbitrarily many or very large parts and exhaust server memory before rejection, so the file-count/size limits are not effective resource limits. Fix: enforce a request-size ceiling at the server/proxy and use a streaming multipart parser that aborts after eight files or when a part/aggregate limit is exceeded.

- `tests/e2e/analysis.spec.ts:223-253` — The E2E submits only text, then changes `analyses.verdict` directly with the service client and reloads; it neither uploads a real file nor lets queued stages consume the supplement and publish the changed verdict. Impact: the passing E2E masks the missing pipeline integration and does not prove accepted upload, processing state, or a worker-produced same-URL verdict. Fix: attach a real image/document through the browser, run the real worker to completion, assert the same URL first shows queued/running state, then assert the new verdict and preserved report content without direct verdict mutation.

- `src/features/supplements/supplement-form.tsx:83-89` — Successful submission clears text and correction fields but leaves `files` populated and rotates to a new idempotency UUID. Impact: pressing “Update analysis” again creates a second run and reuploads the same files as a new group, rather than presenting an empty post-success form. Fix: clear the `files` state and reset the file input after success while retaining a separate read-only processing summary, or close/disable the accepted form until the user starts a new group.

#### Minor

- `src/features/supplements/supplement-form.tsx:98-110` — The closed `<section>` has `aria-labelledby="supplement-title"`, but that heading is rendered only after the action opens the form; the trigger also hard-codes `aria-expanded="false"`. Impact: assistive technology gets a broken section label and inaccurate disclosure state. Fix: keep an always-present visually hidden heading or use an `aria-label` while closed, and bind `aria-expanded`/`aria-controls` to the actual open state.

### Assessment

Fail the Task 12 gate. The implementation has a solid security and transactional shell, but the supplement data is disconnected from the analysis pipeline and the current-run model does not safely preserve or compose report state. The critical findings must be fixed and covered by real pipeline/concurrency/ambiguous-commit tests before approval.
