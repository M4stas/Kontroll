create or replace function public.renew_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds int
)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'worker_id must not be empty';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 1 and 3600';
  end if;

  update public.analysis_jobs as job
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where
    job.id = p_job_id
    and job.status = 'leased'
    and job.leased_by = p_worker_id
    and job.lease_expires_at > clock_timestamp()
  returning job.* into v_job;

  if not found then
    raise exception 'analysis job active lease not found for worker';
  end if;

  return next v_job;
end;
$$;

create or replace function public.complete_analysis_job(
  p_job_id uuid,
  p_worker_id text
)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  update public.analysis_jobs as job
  set
    status = 'complete',
    completed_at = clock_timestamp(),
    leased_by = null,
    lease_expires_at = null,
    last_error = null
  where
    job.id = p_job_id
    and job.status = 'leased'
    and job.leased_by = p_worker_id
    and job.lease_expires_at > clock_timestamp()
  returning job.* into v_job;

  if not found then
    raise exception 'analysis job active lease not found for worker';
  end if;

  return next v_job;
end;
$$;

create or replace function public.retry_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_available_at timestamptz,
  p_message text
)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  update public.analysis_jobs as job
  set
    status = 'queued',
    available_at = p_available_at,
    completed_at = null,
    leased_by = null,
    lease_expires_at = null,
    last_error = jsonb_build_object('message', p_message)
  where
    job.id = p_job_id
    and job.status = 'leased'
    and job.leased_by = p_worker_id
    and job.lease_expires_at > clock_timestamp()
  returning job.* into v_job;

  if not found then
    raise exception 'analysis job active lease not found for worker';
  end if;

  return next v_job;
end;
$$;

create or replace function public.fail_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_message text
)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
begin
  update public.analysis_jobs as job
  set
    status = 'failed',
    completed_at = clock_timestamp(),
    leased_by = null,
    lease_expires_at = null,
    last_error = jsonb_build_object('message', p_message)
  where
    job.id = p_job_id
    and job.status = 'leased'
    and job.leased_by = p_worker_id
    and job.lease_expires_at > clock_timestamp()
  returning job.* into v_job;

  if not found then
    raise exception 'analysis job active lease not found for worker';
  end if;

  return next v_job;
end;
$$;

create or replace function public.save_findings(p_findings jsonb)
returns table (finding_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finding jsonb;
  v_link jsonb;
  v_finding_id uuid;
begin
  if p_findings is null or jsonb_typeof(p_findings) <> 'array' then
    raise exception 'findings must be a JSON array';
  end if;

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    insert into public.findings (
      id,
      analysis_id,
      run_id,
      category,
      severity,
      state,
      title,
      explanation,
      next_action,
      origin
    )
    values (
      coalesce(nullif(v_finding ->> 'id', '')::uuid, gen_random_uuid()),
      (v_finding ->> 'analysis_id')::uuid,
      (v_finding ->> 'run_id')::uuid,
      v_finding ->> 'category',
      v_finding ->> 'severity',
      v_finding ->> 'state',
      v_finding ->> 'title',
      v_finding ->> 'explanation',
      v_finding ->> 'next_action',
      coalesce(v_finding ->> 'origin', 'deterministic')
    )
    returning findings.id into v_finding_id;

    if v_finding ? 'evidence_links'
      and jsonb_typeof(v_finding -> 'evidence_links') <> 'array' then
      raise exception 'evidence_links must be a JSON array';
    end if;

    for v_link in
      select value
      from jsonb_array_elements(coalesce(v_finding -> 'evidence_links', '[]'::jsonb))
    loop
      insert into public.finding_evidence (finding_id, evidence_id, relation)
      values (
        v_finding_id,
        (v_link ->> 'evidence_id')::uuid,
        v_link ->> 'relation'
      );
    end loop;

    finding_id := v_finding_id;
    return next;
  end loop;
end;
$$;

revoke execute on function public.renew_analysis_job(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.renew_analysis_job(uuid, text, int)
  to service_role;

revoke execute on function public.complete_analysis_job(uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_analysis_job(uuid, text)
  to service_role;

revoke execute on function public.retry_analysis_job(uuid, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.retry_analysis_job(uuid, text, timestamptz, text)
  to service_role;

revoke execute on function public.fail_analysis_job(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_analysis_job(uuid, text, text)
  to service_role;

revoke execute on function public.save_findings(jsonb)
  from public, anon, authenticated;
grant execute on function public.save_findings(jsonb)
  to service_role;
