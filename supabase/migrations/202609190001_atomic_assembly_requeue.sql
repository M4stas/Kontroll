create or replace function public.requeue_partial_assembly_job(
  p_analysis_id uuid,
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage_states jsonb;
begin
  if p_analysis_id is null then
    raise exception 'analysis_id must not be null';
  end if;

  if p_run_id is null then
    raise exception 'run_id must not be null';
  end if;

  select run.stage_states
  into v_stage_states
  from public.analysis_runs as run
  where run.id = p_run_id and run.analysis_id = p_analysis_id
  for update;

  if not found then
    raise exception 'analysis run not found for analysis';
  end if;

  if not v_stage_states @> '{"assemble_report":{"version":1,"status":"complete","output":{"advanceToResearch":true}}}'::jsonb then
    return false;
  end if;

  update public.analysis_jobs as job
  set
    status = 'queued',
    available_at = clock_timestamp(),
    completed_at = null,
    last_error = null
  where
    job.analysis_id = p_analysis_id
    and job.run_id = p_run_id
    and job.stage = 'assemble_report'
    and job.status = 'complete';

  return found;
end;
$$;

revoke execute on function public.requeue_partial_assembly_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_partial_assembly_job(uuid, uuid)
  to service_role;

-- Rollback: drop function if exists public.requeue_partial_assembly_job(uuid, uuid);
