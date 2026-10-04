-- Data-preserving rollback: restore the prior leasing/function behavior without
-- dropping rows or columns. Deploy compatible application code before rollback.

create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if worker_id is null or length(btrim(worker_id)) = 0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;
  return query
  with candidate as (
    select job.id
    from public.analysis_jobs as job
    join public.analysis_runs as run on run.id = job.run_id and run.analysis_id = job.analysis_id
    where job.available_at <= clock_timestamp()
      and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp()))
      and not exists (select 1 from public.analysis_jobs as active_job where active_job.run_id = job.run_id and active_job.status = 'leased' and active_job.lease_expires_at > clock_timestamp())
      and not exists (
        select 1 from public.analysis_jobs as earlier_job
        where earlier_job.run_id = job.run_id and earlier_job.available_at <= clock_timestamp()
          and (earlier_job.status = 'queued' or (earlier_job.status = 'leased' and earlier_job.lease_expires_at <= clock_timestamp()))
          and array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'], earlier_job.stage)
            < array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'], job.stage)
      )
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states -> 'capture_listing' ->> 'status' = 'complete'
        when 'baseline_checks' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'research' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'enrich' then run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
        when 'assemble_report' then run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
        else true end
    order by job.available_at, array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'], job.stage), job.created_at
    for update of job skip locked limit 1
  )
  update public.analysis_jobs as job
  set status = 'leased', attempts = job.attempts + 1, leased_by = worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds), completed_at = null
  from candidate where job.id = candidate.id returning job.*;
end;
$$;

-- Retain data and the idempotent save function; only remove the new atomic API.
drop function if exists public.finalize_analysis_report(uuid, uuid, jsonb, public.analysis_status, text, text, timestamptz);
drop function if exists public.save_actions(jsonb, uuid, uuid);
drop function if exists public.save_findings(jsonb, uuid, uuid);
revoke execute on function public.lease_analysis_job(text, int) from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text, int) to service_role;
