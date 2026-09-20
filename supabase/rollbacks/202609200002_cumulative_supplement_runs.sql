-- Deploy code compatible with 202609200001 before running this rollback.
-- The acceptance function must first be restored from
-- 202609200001_atomic_supplement_submissions.sql because its current body
-- references the additive columns below.

drop function if exists public.accept_analysis_submission_group(uuid, uuid, jsonb, text[]);
alter table public.submissions drop column if exists metadata;
alter table public.submissions drop column if exists source_snapshot_id;
drop index if exists public.analysis_runs_parent_run_idx;
alter table public.analysis_runs drop column if exists parent_run_id;

-- Re-apply only the function/grant/comment statements from
-- 202609200001_atomic_supplement_submissions.sql to finish rollback while
-- preserving all analysis, report, submission, and upload rows.
