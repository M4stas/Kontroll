alter table public.analysis_runs
  add column parent_run_id uuid references public.analysis_runs(id) on delete restrict;

create index analysis_runs_parent_run_idx on public.analysis_runs (parent_run_id)
  where parent_run_id is not null;

alter table public.submissions
  add column source_snapshot_id uuid references public.source_snapshots(id) on delete restrict,
  add column metadata jsonb not null default '{}'::jsonb;

do $$
declare
  v_submission record;
  v_source_id uuid;
begin
  for v_submission in
    select id, analysis_id, run_id, kind, provided_by, storage_key
    from public.submissions
    where source_snapshot_id is null and run_id is not null
  loop
    insert into public.source_snapshots (
      analysis_id, run_id, source_type, storage_key, extraction_status, metadata
    ) values (
      v_submission.analysis_id,
      v_submission.run_id,
      'submission',
      v_submission.storage_key,
      'complete',
      jsonb_build_object('kind', v_submission.kind, 'provided_by', v_submission.provided_by)
    ) returning id into v_source_id;

    update public.submissions set source_snapshot_id = v_source_id where id = v_submission.id;
  end loop;
end;
$$;

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
  v_source_id uuid;
  v_stage_states jsonb := '{}'::jsonb;
  v_queued_stages text[] := array[]::text[];
  v_item jsonb;
  v_ordinality bigint;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required';
  end if;

  select analysis.current_run_id
  into v_previous_run_id
  from public.analyses as analysis
  where analysis.id = p_analysis_id
  for update;

  if not found then
    raise exception 'analysis not found';
  end if;

  select run.id
  into v_run_id
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
    select 1
    from jsonb_array_elements(p_submissions) as item
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
      or (nullif(item->>'identity_correction', '') is not null and (
        item->>'identity_correction' not in ('vin', 'registrationPlate')
        or item->>'kind' <> 'seller_answer'
        or nullif(item->>'text_content', '') is null
      ))
  ) then
    raise exception 'submission group contains invalid content';
  end if;

  if v_previous_run_id is not null then
    select coalesce(run.stage_states, '{}'::jsonb)
    into v_stage_states
    from public.analysis_runs as run
    where run.id = v_previous_run_id and run.analysis_id = p_analysis_id;

    select coalesce(array_agg(job.stage), array[]::text[])
    into v_queued_stages
    from public.analysis_jobs as job
    where job.analysis_id = p_analysis_id
      and job.run_id = v_previous_run_id
      and job.status in ('queued', 'leased');
  end if;

  v_queued_stages := v_queued_stages || p_stages;
  if 'assemble_report' = any(v_queued_stages) and not (v_stage_states ? 'baseline_checks') then
    v_queued_stages := v_queued_stages || array['baseline_checks'];
  end if;
  if ('baseline_checks' = any(v_queued_stages) or 'enrich' = any(v_queued_stages))
    and not (v_stage_states ? 'normalize_identity') then
    v_queued_stages := v_queued_stages || array['normalize_identity'];
  end if;
  if 'research' = any(v_queued_stages) and not (v_stage_states ? 'normalize_identity') then
    v_queued_stages := v_queued_stages || array['normalize_identity'];
  end if;
  if 'normalize_identity' = any(v_queued_stages) and not (v_stage_states ? 'capture_listing') then
    v_queued_stages := v_queued_stages || array['capture_listing'];
  end if;

  select array_agg(stage order by array_position(
    array['capture_listing', 'normalize_identity', 'baseline_checks', 'research', 'enrich', 'assemble_report'],
    stage
  ))
  into v_queued_stages
  from (select distinct unnest(v_queued_stages) as stage) as stages;

  v_stage_states := v_stage_states - v_queued_stages;

  insert into public.analysis_runs (
    analysis_id, trigger, stage_states, submission_idempotency_key, parent_run_id
  ) values (
    p_analysis_id, 'supplement', v_stage_states, p_idempotency_key, v_previous_run_id
  ) returning id into v_run_id;

  for v_item, v_ordinality in
    select item.value, item.ordinality
    from jsonb_array_elements(p_submissions) with ordinality as item(value, ordinality)
  loop
    insert into public.source_snapshots (
      analysis_id, run_id, source_type, storage_key, extraction_status, metadata
    ) values (
      p_analysis_id,
      v_run_id,
      'submission',
      nullif(v_item->>'storage_key', ''),
      'complete',
      jsonb_strip_nulls(jsonb_build_object(
        'kind', v_item->>'kind',
        'provided_by', v_item->>'provided_by',
        'identity_correction', nullif(v_item->>'identity_correction', '')
      ))
    ) returning id into v_source_id;

    insert into public.submissions (
      analysis_id, run_id, kind, provided_by, text_content, storage_key, mime_type,
      idempotency_key, source_snapshot_id, metadata
    ) values (
      p_analysis_id,
      v_run_id,
      v_item->>'kind',
      v_item->>'provided_by',
      nullif(v_item->>'text_content', ''),
      nullif(v_item->>'storage_key', ''),
      nullif(v_item->>'mime_type', ''),
      p_analysis_id::text || ':' || p_idempotency_key::text || ':' || v_ordinality::text,
      v_source_id,
      jsonb_strip_nulls(jsonb_build_object('identity_correction', nullif(v_item->>'identity_correction', '')))
    );
  end loop;

  update public.analysis_jobs as obsolete_job
  set
    status = 'failed',
    leased_by = null,
    lease_expires_at = null,
    completed_at = clock_timestamp(),
    last_error = jsonb_build_object('code', 'superseded', 'superseded_by_run_id', v_run_id)
  where obsolete_job.analysis_id = p_analysis_id
    and obsolete_job.run_id = v_previous_run_id
    and obsolete_job.status in ('queued', 'leased');

  insert into public.analysis_jobs (analysis_id, run_id, stage, idempotency_key)
  select p_analysis_id, v_run_id, stage, p_analysis_id::text || ':' || v_run_id::text || ':' || stage
  from unnest(v_queued_stages) as stage;

  update public.analyses
  set current_run_id = v_run_id, status = 'queued', updated_at = clock_timestamp()
  where id = p_analysis_id;

  return query select v_run_id, v_queued_stages, true;
end;
$$;

revoke execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  to service_role;

comment on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  is 'Atomically composes cumulative supplement runs, supersedes obsolete work, and queues missing prerequisites.';
