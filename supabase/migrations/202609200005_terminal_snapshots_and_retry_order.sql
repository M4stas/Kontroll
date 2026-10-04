-- Corrects Task 12's retry ordering and makes durable report publication atomic.
-- Existing rows remain valid; all functions are replace-in-place and idempotent.

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
    select job.id
    from public.analysis_jobs as job
    join public.analysis_runs as run on run.id = job.run_id and run.analysis_id = job.analysis_id
    where job.available_at <= clock_timestamp()
      and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp()))
      and not exists (
        select 1 from public.analysis_jobs as active_job
        where active_job.run_id = job.run_id
          and active_job.status = 'leased'
          and active_job.lease_expires_at > clock_timestamp()
      )
      -- A retried predecessor remains a dependency even while it is backing off.
      -- This only constrains a single run, so independent analyses continue leasing.
      and not exists (
        select 1 from public.analysis_jobs as earlier_job
        where earlier_job.run_id = job.run_id
          and earlier_job.status in ('queued', 'leased')
          and array_position(
            array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'],
            earlier_job.stage
          ) < array_position(
            array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'],
            job.stage
          )
      )
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states -> 'capture_listing' ->> 'status' = 'complete'
        when 'baseline_checks' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'research' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'enrich' then run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
        when 'assemble_report' then run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
        else true
      end
    order by job.available_at,
      array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'], job.stage),
      job.created_at
    for update of job skip locked
    limit 1
  )
  update public.analysis_jobs as job
  set status = 'leased', attempts = job.attempts + 1, leased_by = worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds), completed_at = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

-- Deterministic record IDs are stage-local idempotency keys.  A retry replaces
-- that record's current value and synchronises links rather than duplicating it.
create or replace function public.save_findings(
  p_findings jsonb,
  p_replace_analysis_id uuid default null,
  p_replace_run_id uuid default null
)
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
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then
    raise exception 'replacement analysis and run must be supplied together';
  end if;
  -- Assembly snapshots own the complete finding set for their run.  Removing
  -- stale rows here makes a response-lost retry converge rather than preserving
  -- findings/actions which no longer appear in the assembled report.
  if p_replace_run_id is not null then
    delete from public.findings as stale
    where stale.analysis_id = p_replace_analysis_id
      and stale.run_id = p_replace_run_id
      and not exists (
        select 1 from jsonb_array_elements(p_findings) as incoming(value)
        where nullif(incoming.value ->> 'id', '')::uuid = stale.id
      );
  end if;

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    v_finding_id := coalesce(nullif(v_finding ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.findings (
      id, analysis_id, run_id, category, severity, state, title, explanation, next_action, origin
    ) values (
      v_finding_id,
      (v_finding ->> 'analysis_id')::uuid,
      (v_finding ->> 'run_id')::uuid,
      v_finding ->> 'category', v_finding ->> 'severity', v_finding ->> 'state',
      v_finding ->> 'title', v_finding ->> 'explanation', v_finding ->> 'next_action',
      coalesce(v_finding ->> 'origin', 'deterministic')
    )
    on conflict (id) do update set
      category = excluded.category, severity = excluded.severity, state = excluded.state,
      title = excluded.title, explanation = excluded.explanation,
      next_action = excluded.next_action, origin = excluded.origin
    where public.findings.analysis_id = excluded.analysis_id
      and public.findings.run_id = excluded.run_id;

    if not found then
      raise exception 'finding id belongs to another analysis run';
    end if;
    if v_finding ? 'evidence_links' and jsonb_typeof(v_finding -> 'evidence_links') <> 'array' then
      raise exception 'evidence_links must be a JSON array';
    end if;

    delete from public.finding_evidence as stale
    where stale.finding_id = v_finding_id
      and not exists (
        select 1 from jsonb_array_elements(coalesce(v_finding -> 'evidence_links', '[]'::jsonb)) as incoming(value)
        where (incoming.value ->> 'evidence_id')::uuid = stale.evidence_id
      );
    for v_link in select value from jsonb_array_elements(coalesce(v_finding -> 'evidence_links', '[]'::jsonb))
    loop
      insert into public.finding_evidence (finding_id, evidence_id, relation)
      values (v_finding_id, (v_link ->> 'evidence_id')::uuid, v_link ->> 'relation')
      on conflict on constraint finding_evidence_pkey do update set relation = excluded.relation;
    end loop;
    finding_id := v_finding_id;
    return next;
  end loop;
end;
$$;

create or replace function public.save_actions(
  p_actions jsonb,
  p_replace_analysis_id uuid default null,
  p_replace_run_id uuid default null
)
returns table (action_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_action_id uuid;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    raise exception 'actions must be a JSON array';
  end if;
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then
    raise exception 'replacement analysis and run must be supplied together';
  end if;
  if p_replace_run_id is not null then
    delete from public.actions as stale
    where stale.analysis_id = p_replace_analysis_id
      and stale.run_id = p_replace_run_id
      and not exists (
        select 1 from jsonb_array_elements(p_actions) as incoming(value)
        where nullif(incoming.value ->> 'id', '')::uuid = stale.id
      );
  end if;
  for v_action in select value from jsonb_array_elements(p_actions)
  loop
    v_action_id := coalesce(nullif(v_action ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.actions (
      id, analysis_id, run_id, kind, title, instructions, status, finding_id
    ) values (
      v_action_id,
      (v_action ->> 'analysis_id')::uuid,
      (v_action ->> 'run_id')::uuid,
      v_action ->> 'kind', v_action ->> 'title', v_action ->> 'instructions',
      coalesce(v_action ->> 'status', 'open'), nullif(v_action ->> 'finding_id', '')::uuid
    )
    on conflict (id) do update set
      kind = excluded.kind, title = excluded.title, instructions = excluded.instructions,
      status = excluded.status, finding_id = excluded.finding_id
    where public.actions.analysis_id = excluded.analysis_id
      and public.actions.run_id = excluded.run_id;
    if not found then raise exception 'action id belongs to another analysis run'; end if;
    action_id := v_action_id;
    return next;
  end loop;
end;
$$;

create or replace function public.finalize_analysis_report(
  p_analysis_id uuid,
  p_run_id uuid,
  p_assembly_result jsonb,
  p_status public.analysis_status,
  p_verdict text,
  p_confidence text,
  p_completed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_current boolean := false;
begin
  if p_assembly_result is null or jsonb_typeof(p_assembly_result) <> 'object' then
    raise exception 'assembly result must be an object';
  end if;
  if p_status not in ('partial', 'complete', 'failed') then
    raise exception 'invalid final report status';
  end if;

  select analysis.current_run_id = p_run_id
  into v_is_current
  from public.analyses as analysis
  where analysis.id = p_analysis_id
  for update;
  if not found then raise exception 'analysis not found'; end if;

  update public.analysis_runs as run
  set stage_states = coalesce(run.stage_states, '{}'::jsonb)
        || jsonb_build_object('assemble_report', p_assembly_result),
      status = p_status,
      completed_at = p_completed_at
  where run.id = p_run_id and run.analysis_id = p_analysis_id;
  if not found then raise exception 'analysis run not found'; end if;

  if v_is_current then
    update public.analyses
    set status = p_status, verdict = p_verdict, confidence = p_confidence, updated_at = p_completed_at
    where id = p_analysis_id and current_run_id = p_run_id;
  end if;
  return v_is_current;
end;
$$;

revoke execute on function public.lease_analysis_job(text, int) from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text, int) to service_role;
revoke execute on function public.save_findings(jsonb) from public, anon, authenticated;
grant execute on function public.save_findings(jsonb) to service_role;
revoke execute on function public.save_findings(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_findings(jsonb, uuid, uuid) to service_role;
revoke execute on function public.save_actions(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_actions(jsonb, uuid, uuid) to service_role;
revoke execute on function public.finalize_analysis_report(uuid, uuid, jsonb, public.analysis_status, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_analysis_report(uuid, uuid, jsonb, public.analysis_status, text, text, timestamptz)
  to service_role;

comment on function public.lease_analysis_job(text, int)
  is 'Leases one stage per run; queued and leased predecessor stages remain dependencies across retry backoff.';
comment on function public.finalize_analysis_report(uuid, uuid, jsonb, public.analysis_status, text, text, timestamptz)
  is 'Atomically records terminal assembly state and publishes the current analysis report.';
