-- 006 made the first partial assembly eligible; this follow-up gives that
-- eligible job priority over optional work in the same initial run.
create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs
language plpgsql security definer set search_path = '' as $$
begin
  if worker_id is null or length(btrim(worker_id)) = 0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;
  return query
  with candidate as (
    select job.id
    from public.analysis_jobs job join public.analysis_runs run on run.id=job.run_id and run.analysis_id=job.analysis_id
    where job.available_at<=clock_timestamp()
      and (job.status='queued' or (job.status='leased' and job.lease_expires_at<=clock_timestamp()))
      and not exists (select 1 from public.analysis_jobs active where active.run_id=job.run_id and active.status='leased' and active.lease_expires_at>clock_timestamp())
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states->'capture_listing'->>'status'='complete'
        when 'baseline_checks' then run.stage_states->'normalize_identity'->>'status'='complete'
        when 'research' then run.stage_states->'normalize_identity'->>'status'='complete'
        when 'enrich' then run.stage_states->'baseline_checks'->>'status'='complete' and coalesce(run.stage_states->'research'->>'status','queued') in ('complete','unavailable','failed')
        when 'assemble_report' then run.stage_states->'baseline_checks'->>'status'='complete' and (
          (run.trigger='initial' and not (run.stage_states ? 'assemble_report'))
          or not exists (select 1 from public.analysis_jobs predecessor where predecessor.run_id=job.run_id and predecessor.stage in ('normalize_identity','baseline_checks','research','enrich') and predecessor.status in ('queued','leased'))
        )
        else false
      end
    order by
      (job.stage='assemble_report' and run.trigger='initial' and not (run.stage_states ? 'assemble_report')) desc,
      job.available_at,
      array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'],job.stage),
      job.created_at
    for update of job skip locked limit 1
  ) update public.analysis_jobs job
  set status='leased',attempts=job.attempts+1,leased_by=worker_id,lease_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds),completed_at=null
  from candidate where job.id=candidate.id returning job.*;
end;
$$;
revoke execute on function public.lease_analysis_job(text,int) from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text,int) to service_role;
