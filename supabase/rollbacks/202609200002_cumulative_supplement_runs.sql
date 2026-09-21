-- Deploy application code compatible with the 202609200001 acceptance behavior
-- before this rollback. Additive lineage/provenance columns remain because
-- dropping them would destroy accepted correction and source ownership data.

create or replace function public.accept_analysis_submission_group(
  p_analysis_id uuid,
  p_idempotency_key uuid,
  p_submissions jsonb,
  p_stages text[]
)
returns table (run_id uuid, queued_stages text[], created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_run_id uuid;
  v_run_id uuid;
  v_stage_states jsonb := '{}'::jsonb;
  v_queued_stages text[];
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required';
  end if;

  select analysis.current_run_id into v_previous_run_id
  from public.analyses as analysis
  where analysis.id = p_analysis_id
  for update;
  if not found then raise exception 'analysis not found'; end if;

  select run.id into v_run_id
  from public.analysis_runs as run
  where run.analysis_id = p_analysis_id
    and run.submission_idempotency_key = p_idempotency_key;

  if v_run_id is not null then
    select coalesce(array_agg(job.stage order by array_position(
      array['capture_listing', 'normalize_identity', 'baseline_checks', 'research', 'enrich', 'assemble_report'],
      job.stage
    )), array[]::text[])
    into v_queued_stages
    from public.analysis_jobs as job
    where job.analysis_id = p_analysis_id and job.run_id = v_run_id;
    return query select v_run_id, v_queued_stages, false;
    return;
  end if;

  if jsonb_typeof(p_submissions) <> 'array'
    or jsonb_array_length(p_submissions) < 1
    or jsonb_array_length(p_submissions) > 10 then
    raise exception 'submission group must contain between one and ten items';
  end if;

  if p_stages is null or cardinality(p_stages) < 1
    or exists (
      select 1 from unnest(p_stages) as stage
      where stage not in ('normalize_identity', 'baseline_checks', 'research', 'enrich', 'assemble_report')
    ) then
    raise exception 'submission group contains an invalid affected stage';
  end if;

  if (
    select count(*) from jsonb_array_elements(p_submissions) as item
    where nullif(item->>'storage_key', '') is not null
  ) > 8 then
    raise exception 'submission group cannot contain more than eight files';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_submissions) as item
    where item->>'kind' is null
      or item->>'kind' not in ('seller_answer', 'buyer_note', 'image', 'screenshot', 'document')
      or item->>'provided_by' is null
      or item->>'provided_by' not in ('seller', 'buyer')
      or (nullif(item->>'text_content', '') is null and nullif(item->>'storage_key', '') is null)
      or length(coalesce(item->>'text_content', '')) > 10000
      or (item ? 'storage_key' and (item->>'storage_key') not like p_analysis_id::text || '/%')
      or (nullif(item->>'storage_key', '') is not null and (
        item->>'mime_type' is null
        or item->>'mime_type' not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      ))
  ) then
    raise exception 'submission group contains invalid content';
  end if;

  if v_previous_run_id is not null then
    select coalesce(run.stage_states, '{}'::jsonb) - p_stages
    into v_stage_states
    from public.analysis_runs as run
    where run.id = v_previous_run_id and run.analysis_id = p_analysis_id;
  end if;

  insert into public.analysis_runs (
    analysis_id, trigger, stage_states, submission_idempotency_key
  ) values (
    p_analysis_id, 'supplement', v_stage_states, p_idempotency_key
  ) returning id into v_run_id;

  insert into public.submissions (
    analysis_id, run_id, kind, provided_by, text_content, storage_key, mime_type, idempotency_key
  )
  select
    p_analysis_id,
    v_run_id,
    item.value->>'kind',
    item.value->>'provided_by',
    nullif(item.value->>'text_content', ''),
    nullif(item.value->>'storage_key', ''),
    nullif(item.value->>'mime_type', ''),
    p_analysis_id::text || ':' || p_idempotency_key::text || ':' || item.ordinality::text
  from jsonb_array_elements(p_submissions) with ordinality as item(value, ordinality);

  insert into public.analysis_jobs (analysis_id, run_id, stage, idempotency_key)
  select p_analysis_id, v_run_id, stage, p_analysis_id::text || ':' || v_run_id::text || ':' || stage
  from unnest(p_stages) as stage
  group by stage;

  update public.analyses
  set current_run_id = v_run_id, status = 'queued', updated_at = clock_timestamp()
  where id = p_analysis_id;

  select array_agg(job.stage order by array_position(
    array['capture_listing', 'normalize_identity', 'baseline_checks', 'research', 'enrich', 'assemble_report'],
    job.stage
  ))
  into v_queued_stages
  from public.analysis_jobs as job
  where job.analysis_id = p_analysis_id and job.run_id = v_run_id;

  return query select v_run_id, v_queued_stages, true;
end;
$$;

revoke execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  to service_role;

comment on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  is 'Rolled back to 202609200001 acceptance behavior while preserving additive lineage and provenance data.';
