create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if worker_id is null or length(btrim(worker_id)) = 0 then
    raise exception 'worker_id must not be empty';
  end if;
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 1 and 3600';
  end if;
  return query
  with candidate as (
    select job.id from public.analysis_jobs as job
    where job.available_at <= clock_timestamp()
      and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp()))
    order by job.available_at, job.created_at
    for update skip locked limit 1
  )
  update public.analysis_jobs as job
  set status = 'leased', attempts = job.attempts + 1, leased_by = worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds), completed_at = null
  from candidate where job.id = candidate.id returning job.*;
end;
$$;

revoke execute on function public.lease_analysis_job(text, int) from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text, int) to service_role;
