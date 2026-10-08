-- Only marked PDF ancestry receives reuse; ordinary supersession is unchanged.
alter table public.analysis_runs add column review_reuse_run_id uuid references public.analysis_runs(id) on delete restrict;
alter table public.review_executions add column reused_from_execution_id uuid references public.review_executions(id) on delete set null;
create or replace function public.review_run_is_live(p_analysis_id uuid,p_run_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 with recursive lineage as (
 select run.id,run.review_reuse_run_id from public.analysis_runs run join public.analyses analysis on analysis.current_run_id=run.id and analysis.id=run.analysis_id where analysis.id=p_analysis_id
 union all select parent.id,parent.review_reuse_run_id from public.analysis_runs parent join lineage child on child.review_reuse_run_id=parent.id where parent.analysis_id=p_analysis_id
 ) select exists(select 1 from lineage where id=p_run_id);
$$;
revoke execute on function public.review_run_is_live(uuid,uuid) from public,anon,authenticated;
grant execute on function public.review_run_is_live(uuid,uuid) to service_role;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])'::regprocedure) into definition;
 if position($old$  v_ordinality bigint;$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: accept_analysis_submission_group(uuid,uuid,jsonb,text[])'; end if;
 definition := replace(definition,$old$  v_ordinality bigint;$old$,$new$  v_ordinality bigint;
  v_pdf_reuse boolean := false;$new$);
 if position($old$  v_queued_stages := v_queued_stages || p_stages;$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: accept_analysis_submission_group(uuid,uuid,jsonb,text[])'; end if;
 definition := replace(definition,$old$  v_queued_stages := v_queued_stages || p_stages;$old$,$new$  -- A PDF can race initial snapshot pinning. Preserve the queued/leased parent.
  v_pdf_reuse := v_previous_run_id is not null
    and v_stage_states#>>'{baseline_checks,status}' = 'complete'
    and coalesce(v_stage_states#>>'{research,status}','queued') in ('complete','unavailable')
    and not exists(select 1 from jsonb_array_elements(p_submissions) item where item->>'kind' is distinct from 'document' or item->>'mime_type' is distinct from 'application/pdf' or nullif(item->>'identity_correction','') is not null)
    and (exists(select 1 from public.review_run_snapshots pdf_snapshot where pdf_snapshot.analysis_id=p_analysis_id and pdf_snapshot.run_id=v_previous_run_id)
      or exists(select 1 from public.analysis_jobs pdf_job where pdf_job.analysis_id=p_analysis_id and pdf_job.run_id=v_previous_run_id and pdf_job.stage='enrich' and pdf_job.status in ('queued','leased')));
  if v_pdf_reuse then v_queued_stages := array['enrich','assemble_report'];
  else v_queued_stages := v_queued_stages || p_stages; end if;$new$);
 if position($old$submission_idempotency_key, parent_run_id$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: accept_analysis_submission_group(uuid,uuid,jsonb,text[])'; end if;
 definition := replace(definition,$old$submission_idempotency_key, parent_run_id$old$,$new$submission_idempotency_key, parent_run_id, review_reuse_run_id$new$);
 if position($old$p_idempotency_key, v_previous_run_id
$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: accept_analysis_submission_group(uuid,uuid,jsonb,text[])'; end if;
 definition := replace(definition,$old$p_idempotency_key, v_previous_run_id
$old$,$new$p_idempotency_key, v_previous_run_id, case when v_pdf_reuse then v_previous_run_id end
$new$);
 if position($old$and obsolete_job.status in ('queued', 'leased');$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: accept_analysis_submission_group(uuid,uuid,jsonb,text[])'; end if;
 definition := replace(definition,$old$and obsolete_job.status in ('queued', 'leased');$old$,$new$and obsolete_job.status in ('queued', 'leased')
    and not (v_pdf_reuse and obsolete_job.stage='enrich');$new$);
 execute definition;
end;
$patch$;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.review_assert_live_lease(uuid,uuid,uuid,text)'::regprocedure) into definition;
 if position($old$v_current_run is distinct from p_run_id$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: review_assert_live_lease(uuid,uuid,uuid,text)'; end if;
 definition := replace(definition,$old$v_current_run is distinct from p_run_id$old$,$new$not public.review_run_is_live(p_analysis_id,p_run_id)$new$);
 execute definition;
end;
$patch$;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.lease_analysis_job_scoped(text,integer,uuid)'::regprocedure) into definition;
 if position($old$and job.available_at<=clock_timestamp()$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: lease_analysis_job_scoped(text,integer,uuid)'; end if;
 definition := replace(definition,$old$and job.available_at<=clock_timestamp()$old$,$new$and (job.run_id=(select current_run_id from public.analyses where id=job.analysis_id)
        or (job.stage='enrich' and public.review_run_is_live(job.analysis_id,job.run_id)))
      and not exists (select 1 from public.analysis_jobs parent_job where parent_job.analysis_id=job.analysis_id and parent_job.run_id=run.review_reuse_run_id and parent_job.stage='enrich' and parent_job.status in ('queued','leased'))
      and job.available_at<=clock_timestamp()$new$);
 execute definition;
end;
$patch$;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.pin_review_run_snapshot(uuid,uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 if position($old$  insert into public.review_run_snapshots$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: pin_review_run_snapshot(uuid,uuid,uuid,text,text,jsonb)'; end if;
 definition := replace(definition,$old$  insert into public.review_run_snapshots$old$,$new$  if p_snapshot ? 'finalInput' then
    if jsonb_typeof(p_snapshot->'finalInput') is distinct from 'object'
      or not (p_snapshot->'finalInput' ?& array['vehicle','listing','sourceRecords','evidence'])
      or p_snapshot->'finalInput'->'vehicle' is distinct from p_snapshot->'input'->'vehicle'
      or p_snapshot->'finalInput'->'listing' is distinct from p_snapshot->'input'->'listing'
      or jsonb_typeof(p_snapshot->'finalInput'->'sourceRecords') is distinct from 'array'
      or jsonb_typeof(p_snapshot->'finalInput'->'evidence') is distinct from 'array'
      or jsonb_array_length(p_snapshot->'finalInput'->'sourceRecords')>256
      or jsonb_array_length(p_snapshot->'finalInput'->'evidence')>256 then
      raise exception 'final PDF input projection is invalid';
    end if;
  for v_evidence in select value from jsonb_array_elements(p_snapshot->'finalInput'->'evidence') loop
    if not public.review_evidence_is_owned(p_analysis_id, p_run_id, v_evidence) then
      raise exception 'review snapshot evidence is not owned by this analysis and run lineage';
    end if;
  end loop;
  for v_record in select value from jsonb_array_elements(p_snapshot->'finalInput'->'sourceRecords') loop
    if jsonb_typeof(v_record) is distinct from 'object'
      or not (v_record ?& array['evidenceId','sourceId','kind','content'])
      or jsonb_typeof(v_record->'evidenceId') is distinct from 'string'
      or jsonb_typeof(v_record->'sourceId') is distinct from 'string'
      or v_record->>'kind' is null or v_record->>'kind' not in ('listing_text','listing_fact','seller_reply','buyer_note','official_record','manual_excerpt','vin_record')
      or not exists (select 1 from jsonb_array_elements(p_snapshot->'finalInput'->'evidence') item(value)
        where value->>'id' = v_record->>'evidenceId' and value->>'sourceId' = v_record->>'sourceId') then
      raise exception 'review source record is not linked to pinned owned evidence';
    end if;
  end loop;

  end if;
  insert into public.review_run_snapshots$new$);
 execute definition;
end;
$patch$;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.ensure_review_execution(uuid,uuid,uuid,text,uuid,text,uuid,text,uuid[],jsonb,uuid[],jsonb)'::regprocedure) into definition;
 if position($old$v_snapshot.snapshot->'input'$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: ensure_review_execution(uuid,uuid,uuid,text,uuid,text,uuid,text,uuid[],jsonb,uuid[],jsonb)'; end if;
 definition := replace(definition,$old$v_snapshot.snapshot->'input'$old$,$new$(case when p_pass='final' then coalesce(v_snapshot.snapshot->'finalInput',v_snapshot.snapshot->'input') else v_snapshot.snapshot->'input' end)$new$);
 execute definition;
end;
$patch$;

do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)'::regprocedure) into definition;
 if position($old$  if v_attempt.job_id <> p_job_id$old$ in definition)=0 then raise exception 'PDF migration prerequisite missing: commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)'; end if;
 definition := replace(definition,$old$  if v_attempt.job_id <> p_job_id$old$,$new$  if v_execution.pass='final' and p_outcome='success' and not exists(select 1 from public.analyses where id=p_analysis_id and current_run_id=p_run_id) then
    raise exception 'review run is no longer current';
  end if;
  if v_attempt.job_id <> p_job_id$new$);
 execute definition;
end;
$patch$;

create or replace function public.reuse_committed_pdf_reviews(
 p_analysis_id uuid,p_run_id uuid,p_job_id uuid,p_worker_id text,p_snapshot_id uuid,
 p_execution_id uuid,p_origin_execution_id uuid
) returns void language plpgsql security definer set search_path='' as $$
declare v_parent uuid; v_source public.review_executions%rowtype; v_target public.review_executions%rowtype;
begin
 perform public.review_assert_live_lease(p_analysis_id,p_run_id,p_job_id,p_worker_id);
 select review_reuse_run_id into v_parent from public.analysis_runs where id=p_run_id and analysis_id=p_analysis_id;
 if v_parent is null or exists(select 1 from public.analysis_jobs where analysis_id=p_analysis_id and run_id=v_parent and stage='enrich' and status in ('queued','leased')) then raise exception 'PDF parent review is not terminal'; end if;
 select * into v_source from public.review_executions where id=p_origin_execution_id and analysis_id=p_analysis_id and run_id=v_parent;
 if not found or v_source.pass='final' or v_source.result is null then raise exception 'PDF review origin is invalid'; end if;
 select * into v_target from public.review_executions where id=p_execution_id and analysis_id=p_analysis_id and run_id=p_run_id and snapshot_id=p_snapshot_id for update;
 if not found or v_target.pass<>v_source.pass or v_target.image_evidence_id is distinct from v_source.image_evidence_id
   or v_target.request_projection<>v_source.request_projection
   or not exists(select 1 from public.review_run_snapshots source join public.review_run_snapshots target on target.id=p_snapshot_id where source.id=v_source.snapshot_id and source.analysis_id=p_analysis_id and target.analysis_id=p_analysis_id and source.snapshot->'input'=target.snapshot->'input' and source.snapshot->'imageManifest'=target.snapshot->'imageManifest' and source.snapshot->'passes'=target.snapshot->'passes') then raise exception 'PDF review inputs differ from origin'; end if;
 if v_target.result is not null and (v_target.result_hash<>v_source.result_hash or v_target.reused_from_execution_id is distinct from v_source.id) then raise exception 'PDF review reuse is immutable'; end if;
 update public.review_executions set result=v_source.result,result_hash=v_source.result_hash,completed_at=v_source.completed_at,reused_from_execution_id=v_source.id where id=v_target.id;
end;
$$;
revoke execute on function public.reuse_committed_pdf_reviews(uuid,uuid,uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reuse_committed_pdf_reviews(uuid,uuid,uuid,text,uuid,uuid,uuid) to service_role;
-- Publication uses the independently owned final evidence projection, including PDFs.
do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)'::regprocedure) into definition;
 if position($old$snapshot->'input'->'evidence'$old$ in definition)=0 then raise exception 'PDF final publication evidence prerequisite missing'; end if;
 definition := replace(definition,$old$snapshot->'input'->'evidence'$old$,$new$coalesce(snapshot->'finalInput',snapshot->'input')->'evidence'$new$);
 execute definition;
end;
$patch$;
