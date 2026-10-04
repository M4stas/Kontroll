-- Keep image context citations, incomplete review state, and recovery fencing aligned with the runtime.
create or replace function public.review_result_is_valid(
  p_result jsonb,
  p_pass text,
  p_image_evidence_id uuid,
  p_evidence_ids uuid[]
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_observation jsonb;
  v_action jsonb;
  v_evidence jsonb;
  v_observation_ids text[] := '{}';
  v_observation_id text;
  v_id text;
begin
  if p_result is null or jsonb_typeof(p_result) is distinct from 'object'
    or not (p_result ?& array['schemaVersion','observations','warnings'])
    or p_result->>'schemaVersion' is distinct from '1'
    or (p_result - array['schemaVersion','observations','warnings']) <> '{}'::jsonb
    or jsonb_typeof(p_result->'observations') is distinct from 'array'
    or jsonb_array_length(p_result->'observations') > 64
    or jsonb_typeof(p_result->'warnings') is distinct from 'array'
    or jsonb_array_length(p_result->'warnings') <> 0
    or not public.review_audit_json_safe(p_result) then return false; end if;

  for v_observation in select value from jsonb_array_elements(p_result->'observations') loop
    if jsonb_typeof(v_observation) is distinct from 'object'
      or not (v_observation ?& array['id','evidenceIds','category','title','severity','explanation','recommendedAction','confidence'])
      or (v_observation - array['id','evidenceIds','category','title','severity','explanation','recommendedAction','confidence']) <> '{}'::jsonb
      or jsonb_typeof(v_observation->'id') is distinct from 'string'
      or jsonb_typeof(v_observation->'category') is distinct from 'string'
      or jsonb_typeof(v_observation->'title') is distinct from 'string'
      or jsonb_typeof(v_observation->'severity') is distinct from 'string'
      or jsonb_typeof(v_observation->'explanation') is distinct from 'string'
      or jsonb_typeof(v_observation->'confidence') is distinct from 'number'
      or length(v_observation->>'id') not between 1 and 128
      or length(v_observation->>'category') not between 1 and 100
      or length(v_observation->>'title') not between 1 and 4000
      or length(v_observation->>'explanation') > 20000
      or v_observation->>'severity' is null or v_observation->>'severity' not in ('critical','important','context')
      or (v_observation->>'confidence')::numeric not between 0 and 1
      or jsonb_typeof(v_observation->'evidenceIds') is distinct from 'array'
      or jsonb_array_length(v_observation->'evidenceIds') > 64 then return false; end if;
    v_observation_id := v_observation->>'id';
    if v_observation_id = any(v_observation_ids) then return false; end if;
    v_observation_ids := array_append(v_observation_ids, v_observation_id);
    if v_observation->>'severity' <> 'context' and jsonb_array_length(v_observation->'evidenceIds') = 0 then return false; end if;
    for v_evidence in select value from jsonb_array_elements(v_observation->'evidenceIds') loop
      if jsonb_typeof(v_evidence) is distinct from 'string' then return false; end if;
      v_id := v_evidence #>> '{}';
      if v_id !~* '^[0-9a-f-]{36}$' or p_evidence_ids is null or not (v_id::uuid = any(p_evidence_ids)) then return false; end if;

    end loop;
    if p_pass='image' and (p_image_evidence_id is null or not (v_observation->'evidenceIds' @> jsonb_build_array(p_image_evidence_id::text))) then return false; end if;
    if (select count(*) from jsonb_array_elements(v_observation->'evidenceIds')) <> (select count(distinct value) from jsonb_array_elements(v_observation->'evidenceIds')) then return false; end if;
    v_action := v_observation->'recommendedAction';
    if jsonb_typeof(v_action) is distinct from 'object'
      or not (v_action ?& array['kind','title','instructions'])
      or (v_action - array['kind','title','instructions']) <> '{}'::jsonb
      or jsonb_typeof(v_action->'kind') is distinct from 'string'
      or jsonb_typeof(v_action->'title') is distinct from 'string'
      or jsonb_typeof(v_action->'instructions') is distinct from 'string'
      or v_action->>'kind' is null or v_action->>'kind' not in ('seller_question','photo_request','document_request','workshop_recommendation','inspection_task')
      or length(v_action->>'title') not between 1 and 4000
      or length(v_action->>'instructions') > 20000 then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.fail_analysis_job(p_job_id uuid, p_worker_id text, p_message text)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.analysis_jobs; v_warning text;
begin
  update public.analysis_jobs as job
  set status='failed', completed_at=clock_timestamp(), leased_by=null, lease_expires_at=null,
      last_error=jsonb_build_object('message',p_message)
  where job.id=p_job_id and job.status='leased' and job.leased_by=p_worker_id
    and job.lease_expires_at>clock_timestamp()
  returning job.* into v_job;
  if not found then raise exception 'analysis job active lease not found for worker'; end if;
  if v_job.stage in ('research','enrich') then
    v_warning := v_job.stage || '_unavailable';
    update public.analysis_runs as run
    set stage_states=run.stage_states || jsonb_build_object(v_job.stage,
      jsonb_build_object('version',1,'status','unavailable',
        'output',case when v_job.stage='research' then jsonb_build_object('sourceStates','{}'::jsonb)
          else jsonb_build_object('evidence','[]'::jsonb,'findings','[]'::jsonb,'actions','[]'::jsonb) || case when run.stage_states#>'{enrich,output,review}' is not null then jsonb_build_object('review',jsonb_set(run.stage_states#>'{enrich,output,review}','{state}','"incomplete"'::jsonb)) else '{}'::jsonb end end,
        'warnings',jsonb_build_array(v_warning),'completedAt',clock_timestamp()))
    where run.id=v_job.run_id and run.analysis_id=v_job.analysis_id;
  end if;
  return next v_job;
end;
$$;

create or replace function public.retry_current_review(p_analysis_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_job public.analysis_jobs%rowtype;
begin
 select current_run_id into v_run from public.analyses where id=p_analysis_id for update;
 if v_run is null then return false; end if;
 if exists(select 1 from public.review_executions where analysis_id=p_analysis_id and run_id=v_run and pass='final' and result_hash is not null) then return false; end if;
 select * into v_job from public.analysis_jobs where analysis_id=p_analysis_id and run_id=v_run and stage='enrich' for update;
 if not found then return false; end if;
 if v_job.status in ('queued','leased') then return true; end if;
 update public.review_attempts set state='lost',warning_code='manual_retry',completed_at=clock_timestamp() where job_id=v_job.id and state='started';
 update public.analysis_jobs set status='queued',attempts=0,leased_by=null,lease_expires_at=null,available_at=clock_timestamp(),completed_at=null,last_error=null where id=v_job.id;
 update public.analysis_jobs set status='complete',leased_by=null,lease_expires_at=null,completed_at=clock_timestamp() where analysis_id=p_analysis_id and run_id=v_run and stage='assemble_report' and status<>'leased';
 update public.analysis_runs set stage_states=stage_states-'assemble_report',status='running',failure=null where id=v_run and analysis_id=p_analysis_id;
 update public.analyses set status='partial',updated_at=clock_timestamp() where id=p_analysis_id and current_run_id=v_run;
 return true;
end;$$;

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

  if exists(select 1 from public.review_run_snapshots where analysis_id=p_analysis_id and run_id=p_run_id and snapshot->>'mode'<>'disabled') then
    if exists(select 1 from public.review_executions where analysis_id=p_analysis_id and run_id=p_run_id and pass='final' and result_hash is not null) then
      if p_status<>'complete' or p_assembly_result#>>'{output,review,state}' is distinct from 'complete' then return false; end if;
    elsif p_status='complete' then return false;
    end if;
  end if;


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
