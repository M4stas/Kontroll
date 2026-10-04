-- Finalized review artifacts are immutable through ordinary repository writes.
-- Publication row bound: 66 admitted passes * 64 observations + 64 baseline rows;
-- the independent 1MB UTF8 cap remains the tighter limit for verbose outputs.
-- Both ordinary replacement and final publication lock the analysis row first.
create or replace function public.review_assert_artifacts_mutable(p_analysis_id uuid,p_run_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.analyses where id=p_analysis_id for update;
 if not found then raise exception 'analysis not found'; end if;
 if exists(select 1 from public.review_executions where analysis_id=p_analysis_id and run_id=p_run_id and pass='final' and result_hash is not null) then
   raise exception 'final review artifacts are immutable; create a new review run';
 end if;
end;$$;
revoke all on function public.review_assert_artifacts_mutable(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.save_findings(p_findings jsonb, p_replace_analysis_id uuid default null, p_replace_run_id uuid default null)
returns table(finding_id uuid) language plpgsql security definer set search_path = '' as $$
declare v_scope record;
begin
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then raise exception 'replacement scope must be complete'; end if;
  if p_replace_run_id is not null and not exists (select 1 from public.analysis_runs r
    where r.id=p_replace_run_id and r.analysis_id=p_replace_analysis_id) then raise exception 'replacement run belongs to another analysis'; end if;
  if p_replace_run_id is not null and exists (select 1 from jsonb_array_elements(p_findings) item
    where (item->>'analysis_id')::uuid is distinct from p_replace_analysis_id
      or (item->>'run_id')::uuid is distinct from p_replace_run_id) then raise exception 'finding replacement scope mismatch'; end if;
  if p_replace_run_id is not null then
    perform public.review_assert_artifacts_mutable(p_replace_analysis_id,p_replace_run_id);
  else
    for v_scope in select distinct (value->>'analysis_id')::uuid as analysis_id,(value->>'run_id')::uuid as run_id from jsonb_array_elements(p_findings) order by 1,2 loop
      perform public.review_assert_artifacts_mutable(v_scope.analysis_id,v_scope.run_id);
    end loop;
  end if;
  return query select * from public.save_findings_unchecked(p_findings,p_replace_analysis_id,p_replace_run_id);
end;
$$;

create or replace function public.save_actions(p_actions jsonb, p_replace_analysis_id uuid default null, p_replace_run_id uuid default null)
returns table(action_id uuid) language plpgsql security definer set search_path = '' as $$
declare v_scope record;
begin
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then raise exception 'replacement scope must be complete'; end if;
  if p_replace_run_id is not null and not exists (select 1 from public.analysis_runs r
    where r.id=p_replace_run_id and r.analysis_id=p_replace_analysis_id) then raise exception 'replacement run belongs to another analysis'; end if;
  if p_replace_run_id is not null and exists (select 1 from jsonb_array_elements(p_actions) item
    where (item->>'analysis_id')::uuid is distinct from p_replace_analysis_id
      or (item->>'run_id')::uuid is distinct from p_replace_run_id) then raise exception 'action replacement scope mismatch'; end if;
  if p_replace_run_id is not null then
    perform public.review_assert_artifacts_mutable(p_replace_analysis_id,p_replace_run_id);
  else
    for v_scope in select distinct (value->>'analysis_id')::uuid as analysis_id,(value->>'run_id')::uuid as run_id from jsonb_array_elements(p_actions) order by 1,2 loop
      perform public.review_assert_artifacts_mutable(v_scope.analysis_id,v_scope.run_id);
    end loop;
  end if;
  return query select * from public.save_actions_unchecked(p_actions,p_replace_analysis_id,p_replace_run_id);
end;
$$;
-- The validated final transaction is the sole authorized writer after final-result commit.
create or replace function public.commit_review_attempt(
  p_analysis_id uuid,
  p_run_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_attempt_id uuid,
  p_outcome text,
  p_result jsonb,
  p_warning_code text,
  p_provider_request_id text,
  p_publication jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.review_attempts%rowtype;
  v_execution public.review_executions%rowtype;
  v_result_hash text;
  v_publication_hash text;
  v_state text;
  v_expected_evidence uuid[] := '{}';
  v_finding jsonb;
  v_action jsonb;
  v_link jsonb;
  v_finding_ids uuid[] := '{}';
  v_allowed_evidence uuid[] := '{}';
  v_status public.analysis_status;
  v_current_lease integer;
begin
  if p_outcome not in ('success','failure','unavailable','lost')
    or (p_warning_code is not null and p_warning_code !~ '^[a-z][a-z0-9_]{0,63}$')
    or (p_provider_request_id is not null and (p_provider_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
      or p_provider_request_id ~* '(https?://|bearer|sk-(proj-)?|api.?key|token|signature)')) then
    raise exception 'review attempt outcome or safe metadata is invalid';
  end if;
  select attempt.* into v_attempt from public.review_attempts as attempt
  where attempt.id = p_attempt_id and attempt.analysis_id = p_analysis_id and attempt.run_id = p_run_id;
  if not found then raise exception 'review attempt does not belong to this run'; end if;
  select * into v_execution from public.review_executions as execution
  where execution.id = v_attempt.execution_id and execution.analysis_id = p_analysis_id and execution.run_id = p_run_id;
  if not found or v_execution.pass not in ('text','image','final') then raise exception 'review execution is invalid'; end if;

  if v_attempt.state <> 'started' then
    v_result_hash := case when p_outcome = 'success' and p_result is not null
      then encode(extensions.digest(convert_to(p_result::text, 'UTF8'), 'sha256'), 'hex') else null end;
    v_publication_hash := case when p_publication is not null
      then encode(extensions.digest(convert_to(p_publication::text, 'UTF8'), 'sha256'), 'hex') else null end;
    if v_attempt.state = p_outcome and v_attempt.result_hash is not distinct from v_result_hash
      and v_attempt.publication_hash is not distinct from v_publication_hash
      and v_attempt.warning_code is not distinct from p_warning_code
      and v_attempt.provider_request_id is not distinct from p_provider_request_id then
      return;
    end if;
    raise exception 'review attempt has already been committed with a different outcome';
  end if;

  v_current_lease := public.review_assert_live_lease(p_analysis_id, p_run_id, p_job_id, p_worker_id);
  if v_attempt.job_id <> p_job_id or v_attempt.worker_id <> p_worker_id
    or v_attempt.job_lease_attempt <> v_current_lease then
    raise exception 'review attempt lease ownership changed';
  end if;
  if p_outcome = 'success' then
    if p_result is null or not public.review_result_is_valid(p_result, v_execution.pass, v_execution.image_evidence_id, v_execution.evidence_ids) then
      raise exception 'review success result is invalid or contains warnings';
    end if;
    if v_execution.result_hash is not null then raise exception 'review success is immutable'; end if;
    v_result_hash := encode(extensions.digest(convert_to(p_result::text, 'UTF8'), 'sha256'), 'hex');
  elsif p_result is not null or p_publication is not null then
    raise exception 'non-success review attempts cannot include a result or publication';
  end if;

  if v_execution.pass = 'final' and p_outcome = 'success' then
    if p_publication is null or not public.review_barrier_matches(
      p_analysis_id, p_run_id, v_execution.snapshot_id, v_execution.prior_execution_ids, v_execution.prior_result_hashes
    ) then raise exception 'final review cannot publish before every scheduled pass is committed'; end if;
    if not public.review_audit_json_safe(p_publication)
      or jsonb_typeof(p_publication) is distinct from 'object'
      or not (p_publication ?& array['assembly_result','status','verdict','confidence','completed_at','findings','actions'])
      or (p_publication - array['assembly_result','status','verdict','confidence','completed_at','findings','actions']) <> '{}'::jsonb
      or jsonb_typeof(p_publication->'assembly_result') is distinct from 'object'
      or octet_length((p_publication->'assembly_result')::text) > 200000
      or octet_length(p_publication::text) > 1000000
      or p_publication->>'status' is null or p_publication->>'status' not in ('partial','complete')
      or (jsonb_typeof(p_publication->'verdict') is distinct from 'string' and jsonb_typeof(p_publication->'verdict') is distinct from 'null')
      or (p_publication->>'verdict' is not null and p_publication->>'verdict' not in ('worth_viewing','proceed_cautiously','likely_skip'))
      or (jsonb_typeof(p_publication->'confidence') is distinct from 'string' and jsonb_typeof(p_publication->'confidence') is distinct from 'null')
      or (p_publication->>'confidence' is not null and p_publication->>'confidence' not in ('low','moderate','high'))
      or (p_publication->>'completed_at') is null
      or jsonb_typeof(p_publication->'findings') is distinct from 'array' or jsonb_array_length(p_publication->'findings') > 4288
      or jsonb_typeof(p_publication->'actions') is distinct from 'array' or jsonb_array_length(p_publication->'actions') > 4288 then
      raise exception 'final publication is malformed or exceeds its size limit';
    end if;
    v_status := (p_publication->>'status')::public.analysis_status;

    select array_agg((value->>'id')::uuid) into v_allowed_evidence
    from jsonb_array_elements((select snapshot->'input'->'evidence' from public.review_run_snapshots where id = v_execution.snapshot_id)) as item(value);
    for v_finding in select value from jsonb_array_elements(p_publication->'findings') loop
      if jsonb_typeof(v_finding) <> 'object'
        or not (v_finding ?& array['id','analysis_id','run_id','category','severity','state','title','explanation','next_action','origin','evidence_links'])
        or (v_finding - array['id','analysis_id','run_id','category','severity','state','title','explanation','next_action','origin','evidence_links']) <> '{}'::jsonb
        or (v_finding->>'id') !~* '^[0-9a-f-]{36}$' or (v_finding->>'id')::uuid = any(v_finding_ids)
        or v_finding->>'analysis_id' <> p_analysis_id::text or v_finding->>'run_id' <> p_run_id::text
        or length(coalesce(v_finding->>'category','')) not between 1 and 128
        or v_finding->>'severity' not in ('critical','important','context')
        or v_finding->>'state' not in ('open','confirmed','cleared')
        or length(coalesce(v_finding->>'title','')) not between 1 and 4000
        or length(coalesce(v_finding->>'explanation','')) > 20000
        or length(coalesce(v_finding->>'next_action','')) > 20000
        or v_finding->>'origin' not in ('deterministic','agent')
        or jsonb_typeof(v_finding->'evidence_links') <> 'array'
        or jsonb_array_length(v_finding->'evidence_links') > 64 then
        raise exception 'final finding is malformed or outside this run';
      end if;
      v_finding_ids := array_append(v_finding_ids, (v_finding->>'id')::uuid);
      for v_link in select value from jsonb_array_elements(v_finding->'evidence_links') loop
        if jsonb_typeof(v_link) <> 'object'
          or not (v_link ?& array['evidence_id','relation'])
          or (v_link - array['evidence_id','relation']) <> '{}'::jsonb
          or (v_link->>'evidence_id') !~* '^[0-9a-f-]{36}$'
          or v_link->>'relation' not in ('supports','contradicts')
          or not ((v_link->>'evidence_id')::uuid = any(coalesce(v_allowed_evidence, '{}')))
          or not exists (select 1 from jsonb_array_elements((select snapshot->'input'->'evidence' from public.review_run_snapshots where id = v_execution.snapshot_id)) item(value)
            where value->>'id' = v_link->>'evidence_id' and public.review_evidence_is_owned(p_analysis_id, p_run_id, value)) then
          raise exception 'final finding cites evidence outside its pinned analysis input';
        end if;
      end loop;
    end loop;

    for v_action in select value from jsonb_array_elements(p_publication->'actions') loop
      if jsonb_typeof(v_action) <> 'object'
        or not (v_action ?& array['id','analysis_id','run_id','kind','title','instructions','status','finding_id'])
        or (v_action - array['id','analysis_id','run_id','kind','title','instructions','status','finding_id']) <> '{}'::jsonb
        or (v_action->>'id') !~* '^[0-9a-f-]{36}$'
        or v_action->>'analysis_id' <> p_analysis_id::text or v_action->>'run_id' <> p_run_id::text
        or v_action->>'kind' not in ('seller_question','photo_request','document_request','workshop_recommendation','inspection_task')
        or length(coalesce(v_action->>'title','')) > 4000 or length(coalesce(v_action->>'instructions','')) > 20000
        or v_action->>'status' not in ('open','complete')
        or (nullif(v_action->>'finding_id','') is not null and not ((v_action->>'finding_id')::uuid = any(coalesce(v_finding_ids, '{}')))) then
        raise exception 'final action is malformed or outside this run';
      end if;
    end loop;

    -- Recheck just before the first publication write; the job and analysis rows
    -- stay locked through commit, so expiry or a superseding supplement cannot race.
    if not exists (select 1 from public.analysis_jobs job where job.id = p_job_id
      and job.status = 'leased' and job.leased_by = p_worker_id and job.lease_expires_at > clock_timestamp()) then
      raise exception 'review enrich lease expired before publication';
    end if;
    if not public.review_result_is_valid(p_result, 'final', null, v_execution.evidence_ids) then
      raise exception 'final review result is invalid';
    end if;
    v_publication_hash := encode(extensions.digest(convert_to(p_publication::text, 'UTF8'), 'sha256'), 'hex');
  elsif p_publication is not null then
    raise exception 'only successful final review may publish';
  end if;

  update public.review_attempts set state = p_outcome, warning_code = p_warning_code,
    provider_request_id = p_provider_request_id, result_hash = v_result_hash,
    publication_hash = v_publication_hash, completed_at = clock_timestamp()
  where id = p_attempt_id and state = 'started';
  if not found then raise exception 'review attempt changed while committing'; end if;

  if p_outcome = 'success' then
    update public.review_executions set result = p_result, result_hash = v_result_hash, completed_at = clock_timestamp()
    where id = v_execution.id and result_hash is null;
    if not found then raise exception 'review success was already committed'; end if;
  end if;

  if v_execution.pass = 'final' and p_outcome = 'success' then
    perform finding_id from public.save_findings_unchecked(p_publication->'findings', p_analysis_id, p_run_id);
    perform action_id from public.save_actions_unchecked(p_publication->'actions', p_analysis_id, p_run_id);
    if not public.finalize_analysis_report(
      p_analysis_id, p_run_id, p_publication->'assembly_result', v_status,
      p_publication->>'verdict', p_publication->>'confidence', (p_publication->>'completed_at')::timestamptz
    ) then raise exception 'review run is no longer current'; end if;
  end if;
end;
$$;
