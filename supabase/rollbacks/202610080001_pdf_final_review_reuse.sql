-- Restore the previous RPC definitions; preserve runs, snapshots and results. Stop workers first.


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
      where stage not in ('capture_listing', 'normalize_identity', 'baseline_checks', 'research', 'enrich', 'assemble_report')
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

create or replace function public.review_assert_live_lease(
  p_analysis_id uuid, p_run_id uuid, p_job_id uuid, p_worker_id text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_run uuid;
  v_job public.analysis_jobs%rowtype;
begin
  select analysis.current_run_id into v_current_run
  from public.analyses as analysis
  where analysis.id = p_analysis_id
  for update;
  if not found or v_current_run is distinct from p_run_id then
    raise exception 'review run is no longer current';
  end if;

  perform 1 from public.analysis_runs as run
  where run.id = p_run_id and run.analysis_id = p_analysis_id
  for update;
  if not found then raise exception 'review run ownership mismatch'; end if;

  select job.* into v_job from public.analysis_jobs as job
  where job.id = p_job_id and job.analysis_id = p_analysis_id and job.run_id = p_run_id
  for update;
  if not found or v_job.stage <> 'enrich' or v_job.status <> 'leased'
    or v_job.leased_by is distinct from p_worker_id
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'review enrich lease is not live or owned by this worker';
  end if;
  return v_job.attempts;
end;
$$;

create or replace function public.pin_review_run_snapshot(
  p_analysis_id uuid,
  p_run_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_input_hash text,
  p_snapshot jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.review_run_snapshots%rowtype;
  v_image jsonb;
  v_evidence jsonb;
  v_record jsonb;
  v_pass record;
  v_supplied integer;
  v_selected integer;
  v_accepted integer;
  v_skipped integer;
  v_rejected integer;
  v_unavailable integer;
  v_pass_count integer;
begin
  perform public.review_assert_live_lease(p_analysis_id, p_run_id, p_job_id, p_worker_id);
  select * into v_existing from public.review_run_snapshots as saved
  where saved.analysis_id = p_analysis_id and saved.run_id = p_run_id;
  if found then
    if p_input_hash is null or v_existing.input_hash is distinct from p_input_hash then
      raise exception 'review run already has a different immutable input snapshot';
    end if;
    return v_existing.id;
  end if;

  if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
    or not (p_snapshot ?& array['analysisId','runId','inputHash','preparationVersion','schemaVersion','locale','mode','input','imageManifest','passes'])
    or p_snapshot->>'analysisId' is distinct from p_analysis_id::text
    or p_snapshot->>'runId' is distinct from p_run_id::text
    or p_snapshot->>'inputHash' is distinct from p_input_hash
    or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
    or not public.review_audit_json_safe(p_snapshot)
    or octet_length(p_snapshot::text) > 2000000 then
    raise exception 'review snapshot is malformed, unsafe, or exceeds its size limit';
  end if;
  if jsonb_typeof(p_snapshot->'preparationVersion') is distinct from 'number'
    or jsonb_typeof(p_snapshot->'schemaVersion') is distinct from 'number'
    or p_snapshot->>'preparationVersion' !~ '^[1-9][0-9]{0,2}$'
    or p_snapshot->>'schemaVersion' !~ '^[1-9][0-9]{0,2}$'
    or p_snapshot->>'locale' is null or p_snapshot->>'locale' not in ('et', 'en')
    or p_snapshot->>'mode' is null or p_snapshot->>'mode' not in ('unified', 'split', 'disabled', 'unavailable')
    or jsonb_typeof(p_snapshot->'input') is distinct from 'object'
    or not (p_snapshot->'input' ?& array['vehicle','listing','sourceRecords','evidence'])
    or jsonb_typeof(p_snapshot->'input'->'vehicle') is distinct from 'object'
    or (jsonb_typeof(p_snapshot->'input'->'listing') is distinct from 'object'
      and jsonb_typeof(p_snapshot->'input'->'listing') is distinct from 'null')
    or jsonb_typeof(p_snapshot->'input'->'sourceRecords') is distinct from 'array'
    or jsonb_array_length(p_snapshot->'input'->'sourceRecords') > 256
    or jsonb_typeof(p_snapshot->'input'->'evidence') is distinct from 'array'
    or jsonb_array_length(p_snapshot->'input'->'evidence') > 256
    or jsonb_typeof(p_snapshot->'imageManifest') is distinct from 'object'
    or not (p_snapshot->'imageManifest' ?& array['images','counts'])
    or jsonb_typeof(p_snapshot->'imageManifest'->'images') is distinct from 'array'
    or jsonb_array_length(p_snapshot->'imageManifest'->'images') > 256
    or jsonb_typeof(p_snapshot->'imageManifest'->'counts') is distinct from 'object'
    or not (p_snapshot->'imageManifest'->'counts' ?& array['supplied','selected','accepted','skipped','rejected','unavailable'])
    or jsonb_typeof(p_snapshot->'passes') is distinct from 'object'
    or not (p_snapshot->'passes' ?& array['text','image','final']) then
    raise exception 'review snapshot versions, locale, mode, input, image manifest, or passes are invalid';
  end if;
  select count(*)::integer into v_pass_count from jsonb_object_keys(p_snapshot->'passes');
  if v_pass_count <> 3 then raise exception 'review snapshot requires exactly three pass settings'; end if;

  for v_pass in select key, value from jsonb_each(p_snapshot->'passes') loop
    if v_pass.key not in ('text', 'image', 'final')
      or jsonb_typeof(v_pass.value) is distinct from 'object'
      or not (v_pass.value ?& array['availability','options','prompt'])
      or v_pass.value->>'availability' is null or v_pass.value->>'availability' not in ('ready', 'unavailable', 'disabled')
      or jsonb_typeof(v_pass.value->'options') is distinct from 'object'
      or jsonb_typeof(v_pass.value->'prompt') is distinct from 'object'
      or not (v_pass.value->'prompt' ?& array['content','hash'])
      or jsonb_typeof(v_pass.value->'prompt'->'content') is distinct from 'string'
      or v_pass.value->'prompt'->>'hash' !~ '^[a-f0-9]{64}$'
      or encode(extensions.digest(convert_to(v_pass.value->'prompt'->>'content', 'UTF8'), 'sha256'), 'hex') is distinct from v_pass.value->'prompt'->>'hash' then
      raise exception 'review pass prompt or availability is invalid';
    end if;
    if v_pass.value->>'availability' = 'ready'
      and (nullif(v_pass.value->>'provider','') is null or nullif(v_pass.value->>'model','') is null
        or jsonb_typeof(v_pass.value->'capabilities') is distinct from 'object') then
      raise exception 'ready review pass is missing effective settings';
    end if;
  end loop;

  select count(*)::integer,
    count(*) filter (where value->>'selected' = 'true')::integer,
    count(*) filter (where value->>'status' = 'accepted')::integer,
    count(*) filter (where value->>'status' = 'skipped')::integer,
    count(*) filter (where value->>'status' = 'rejected')::integer,
    count(*) filter (where value->>'status' = 'unavailable')::integer
  into v_supplied, v_selected, v_accepted, v_skipped, v_rejected, v_unavailable
  from jsonb_array_elements(p_snapshot->'imageManifest'->'images');
  if (p_snapshot->'imageManifest'->'counts'->>'supplied')::integer is distinct from v_supplied
    or (p_snapshot->'imageManifest'->'counts'->>'selected')::integer is distinct from v_selected
    or (p_snapshot->'imageManifest'->'counts'->>'accepted')::integer is distinct from v_accepted
    or (p_snapshot->'imageManifest'->'counts'->>'skipped')::integer is distinct from v_skipped
    or (p_snapshot->'imageManifest'->'counts'->>'rejected')::integer is distinct from v_rejected
    or (p_snapshot->'imageManifest'->'counts'->>'unavailable')::integer is distinct from v_unavailable then
    raise exception 'review image manifest counts do not match its entries';
  end if;
  if v_supplied <> (select count(distinct value->>'evidenceId') from jsonb_array_elements(p_snapshot->'imageManifest'->'images')) then
    raise exception 'review image manifest contains duplicate evidence identities';
  end if;
  for v_image in select value from jsonb_array_elements(p_snapshot->'imageManifest'->'images') loop
    if jsonb_typeof(v_image) is distinct from 'object'
      or not (v_image ?& array['evidenceId','selected','status'])
      or jsonb_typeof(v_image->'evidenceId') is distinct from 'string'
      or jsonb_typeof(v_image->'selected') is distinct from 'boolean'
      or v_image->>'evidenceId' !~* '^[0-9a-f-]{36}$'
      or v_image->>'status' is null or v_image->>'status' not in ('accepted','skipped','rejected','unavailable') then
      raise exception 'review image manifest identity or status is invalid';
    end if;
    if (v_image->>'selected')::boolean and v_image->>'status' = 'skipped' then
      raise exception 'a selected review image cannot be skipped';
    end if;
    if v_image->>'status' = 'accepted' and ((v_image->>'selected') is distinct from 'true'
      or jsonb_typeof(v_image->'storageKey') is distinct from 'string'
      or left(v_image->>'storageKey', length(p_analysis_id::text || '/')) is distinct from p_analysis_id::text || '/'
      or length(v_image->>'storageKey') <= length(p_analysis_id::text || '/')
      or jsonb_typeof(v_image->'contentHash') is distinct from 'string'
      or v_image->>'contentHash' !~ '^[a-f0-9]{64}$'
      or v_image->>'mimeType' is null or v_image->>'mimeType' not in ('image/jpeg', 'image/png', 'image/webp')
      or not public.review_image_is_owned(p_analysis_id, p_run_id, (v_image->>'evidenceId')::uuid,
        'accepted', v_image->>'storageKey', v_image->>'contentHash', v_image->>'mimeType')) then
      raise exception 'accepted review images require selected analysis-owned bytes and a content hash';
    end if;
  end loop;

  for v_evidence in select value from jsonb_array_elements(p_snapshot->'input'->'evidence') loop
    if not public.review_evidence_is_owned(p_analysis_id, p_run_id, v_evidence) then
      raise exception 'review snapshot evidence is not owned by this analysis and run lineage';
    end if;
  end loop;
  for v_record in select value from jsonb_array_elements(p_snapshot->'input'->'sourceRecords') loop
    if jsonb_typeof(v_record) is distinct from 'object'
      or not (v_record ?& array['evidenceId','sourceId','kind','content'])
      or jsonb_typeof(v_record->'evidenceId') is distinct from 'string'
      or jsonb_typeof(v_record->'sourceId') is distinct from 'string'
      or v_record->>'kind' is null or v_record->>'kind' not in ('listing_text','listing_fact','seller_reply','buyer_note','official_record','manual_excerpt','vin_record')
      or not exists (select 1 from jsonb_array_elements(p_snapshot->'input'->'evidence') item(value)
        where value->>'id' = v_record->>'evidenceId' and value->>'sourceId' = v_record->>'sourceId') then
      raise exception 'review source record is not linked to pinned owned evidence';
    end if;
  end loop;

  insert into public.review_run_snapshots (analysis_id, run_id, input_hash, snapshot)
  values (p_analysis_id, p_run_id, p_input_hash, p_snapshot)
  on conflict (analysis_id, run_id) do nothing;
  select * into v_existing from public.review_run_snapshots as saved
  where saved.analysis_id = p_analysis_id and saved.run_id = p_run_id;
  if not found or v_existing.input_hash is distinct from p_input_hash then
    raise exception 'review run already has a different immutable input snapshot';
  end if;
  return v_existing.id;
end;
$$;

create or replace function public.ensure_review_execution(
  p_analysis_id uuid,
  p_run_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_snapshot_id uuid,
  p_pass text,
  p_image_evidence_id uuid,
  p_fingerprint text,
  p_evidence_ids uuid[],
  p_request_projection jsonb,
  p_prior_execution_ids uuid[],
  p_prior_result_hashes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot public.review_run_snapshots%rowtype;
  v_execution public.review_executions%rowtype;
  v_image jsonb;
  v_expected uuid[] := '{}';
  v_expected_evidence uuid[] := '{}';
  v_prior jsonb;
  v_prior_row public.review_executions%rowtype;
  v_index integer;
begin
  perform public.review_assert_live_lease(p_analysis_id, p_run_id, p_job_id, p_worker_id);
  if p_pass is null or p_pass not in ('text', 'image', 'final') or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or p_evidence_ids is null or cardinality(p_evidence_ids) > 256
    or p_request_projection is null or jsonb_typeof(p_request_projection) is distinct from 'object'
    or not (p_request_projection ?& array['pass','locale','vehicle','listing','sourceRecords','evidence','imageEvidenceIds'])
    or (p_request_projection - array['pass','locale','vehicle','listing','sourceRecords','evidence','imageEvidenceIds','imageEvidenceId','priorReviews']) <> '{}'::jsonb
    or jsonb_typeof(p_request_projection->'vehicle') is distinct from 'object'
    or (jsonb_typeof(p_request_projection->'listing') is distinct from 'object' and jsonb_typeof(p_request_projection->'listing') is distinct from 'null')
    or jsonb_typeof(p_request_projection->'sourceRecords') is distinct from 'array'
    or jsonb_typeof(p_request_projection->'evidence') is distinct from 'array'
    or jsonb_typeof(p_request_projection->'imageEvidenceIds') is distinct from 'array'
    or not public.review_audit_json_safe(p_request_projection)
    or octet_length(p_request_projection::text) > 1000000 then
    raise exception 'review execution identity or request projection is invalid';
  end if;
  select * into v_snapshot from public.review_run_snapshots
  where id = p_snapshot_id and analysis_id = p_analysis_id and run_id = p_run_id
  for key share;
  if not found then raise exception 'review snapshot does not belong to this run'; end if;
  if v_snapshot.snapshot->'passes'->p_pass->>'availability' is distinct from 'ready'
    or p_request_projection->>'pass' is distinct from p_pass
    or p_request_projection->>'locale' is distinct from v_snapshot.snapshot->>'locale'
    or p_request_projection->'vehicle' is distinct from v_snapshot.snapshot->'input'->'vehicle'
    or p_request_projection->'listing' is distinct from v_snapshot.snapshot->'input'->'listing'
    or p_request_projection->'sourceRecords' is distinct from v_snapshot.snapshot->'input'->'sourceRecords'
    or p_request_projection->'evidence' is distinct from v_snapshot.snapshot->'input'->'evidence' then
    raise exception 'review execution differs from its immutable run snapshot';
  end if;
  select coalesce(array_agg((value->>'id')::uuid order by ordinality), '{}') into v_expected_evidence
  from jsonb_array_elements(v_snapshot.snapshot->'input'->'evidence') with ordinality as item(value, ordinality);
  if p_pass = 'image' and not (p_image_evidence_id = any(v_expected_evidence)) then
    v_expected_evidence := array_append(v_expected_evidence, p_image_evidence_id);
  end if;
  if p_evidence_ids is distinct from v_expected_evidence then
    raise exception 'review execution evidence identifiers do not match the pinned pass input';
  end if;

  if exists (
    select 1 from unnest(p_evidence_ids) as listed(evidence_id)
    where not exists (select 1 from jsonb_array_elements(v_snapshot.snapshot->'input'->'evidence') as item(value)
      where value->>'id' = listed.evidence_id::text)
      and not (p_pass = 'image' and listed.evidence_id = p_image_evidence_id and exists (
        select 1 from jsonb_array_elements(v_snapshot.snapshot->'imageManifest'->'images') as image(value)
        where value->>'evidenceId' = p_image_evidence_id::text
          and value->>'selected' = 'true' and value->>'status' = 'accepted'
          and jsonb_typeof(value->'contentHash') is not distinct from 'string'
          and value->>'contentHash' ~ '^[a-f0-9]{64}$'
      ))
  ) then raise exception 'review execution evidence is outside the pinned snapshot'; end if;

  if p_pass = 'image' then
    if p_image_evidence_id is null or p_request_projection->>'imageEvidenceId' is distinct from p_image_evidence_id::text
      or p_request_projection->'imageEvidenceIds' is distinct from jsonb_build_array(p_image_evidence_id::text) then
      raise exception 'image execution must contain exactly its selected image identity';
    end if;
    select value into v_image from jsonb_array_elements(v_snapshot.snapshot->'imageManifest'->'images') as image(value)
    where value->>'evidenceId' = p_image_evidence_id::text and value->>'selected' = 'true' and value->>'status' = 'accepted';
    if not found or v_image->>'contentHash' is null then raise exception 'image is not accepted in the pinned run'; end if;
  elsif p_image_evidence_id is not null or coalesce(p_request_projection->'imageEvidenceIds', '[]'::jsonb) <> '[]'::jsonb
    or p_request_projection ? 'imageEvidenceId' then
    raise exception 'text and final executions cannot contain image capabilities';
  end if;

  if p_pass = 'final' then
    if p_prior_execution_ids is null or p_prior_result_hashes is null
      or jsonb_typeof(p_prior_result_hashes) is distinct from 'array'
      or not (p_request_projection ? 'priorReviews') then
      raise exception 'final review is missing its pinned prior execution barrier';
    end if;
    if not public.review_barrier_matches(p_analysis_id, p_run_id, p_snapshot_id, p_prior_execution_ids, p_prior_result_hashes) then
      raise exception 'final review barrier is incomplete or prior execution hashes changed';
    end if;
    v_expected := p_prior_execution_ids;
    if jsonb_typeof(p_request_projection->'priorReviews') <> 'array'
      or jsonb_array_length(p_request_projection->'priorReviews') <> cardinality(v_expected) then
      raise exception 'final request does not contain every committed prior review';
    end if;
    for v_index in 1..cardinality(v_expected) loop
      v_prior := p_request_projection->'priorReviews'->(v_index - 1);
      select * into v_prior_row from public.review_executions
      where id = v_expected[v_index] and analysis_id = p_analysis_id and run_id = p_run_id;
      if not found or v_prior_row.result_hash is null or jsonb_typeof(v_prior) is distinct from 'object'
        or not (v_prior ?& array['executionId','pass','result'])
        or (v_prior - array['executionId','pass','result','imageEvidenceId']) <> '{}'::jsonb
        or v_prior->>'executionId' is distinct from v_prior_row.id::text
        or v_prior->>'pass' is distinct from v_prior_row.pass
        or v_prior->'result' is distinct from v_prior_row.result
        or (v_prior_row.pass = 'image' and v_prior->>'imageEvidenceId' is distinct from v_prior_row.image_evidence_id::text)
        or (v_prior_row.pass <> 'image' and v_prior ? 'imageEvidenceId') then
        raise exception 'final request prior reviews do not match the committed results';
      end if;
    end loop;
  elsif coalesce(cardinality(p_prior_execution_ids), 0) <> 0
    or p_prior_result_hashes is distinct from '[]'::jsonb
    or p_request_projection ? 'priorReviews' then
    raise exception 'only the final review may include prior results';
  end if;

  insert into public.review_executions (
    analysis_id, run_id, snapshot_id, pass, image_evidence_id, fingerprint,
    evidence_ids, prior_execution_ids, prior_result_hashes, request_projection
  ) values (
    p_analysis_id, p_run_id, p_snapshot_id, p_pass, p_image_evidence_id, p_fingerprint,
    coalesce(p_evidence_ids, '{}'), coalesce(p_prior_execution_ids, '{}'), coalesce(p_prior_result_hashes, '[]'::jsonb), p_request_projection
  ) on conflict do nothing;
  select * into v_execution from public.review_executions
  where analysis_id = p_analysis_id and run_id = p_run_id and pass = p_pass
    and image_evidence_id is not distinct from p_image_evidence_id;
  if not found or v_execution.fingerprint <> p_fingerprint
    or v_execution.snapshot_id <> p_snapshot_id
    or v_execution.request_projection <> p_request_projection then
    raise exception 'review execution already exists with a different immutable request';
  end if;
  return v_execution.id;
end;
$$;

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

-- Both global workers and isolated test workers use the same lease decision.
create or replace function public.lease_analysis_job_scoped(worker_id text, lease_seconds int, p_analysis_id uuid)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
begin
  if worker_id is null or length(btrim(worker_id))=0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds<1 or lease_seconds>3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;
  return query with candidate as (
    select job.id from public.analysis_jobs job
    join public.analysis_runs run on run.id=job.run_id and run.analysis_id=job.analysis_id
    where (p_analysis_id is null or job.analysis_id=p_analysis_id)
      and job.available_at<=clock_timestamp() and (job.status='queued' or (job.status='leased' and job.lease_expires_at<=clock_timestamp()))
      and not exists (select 1 from public.analysis_jobs active where active.run_id=job.run_id and active.status='leased' and active.lease_expires_at>clock_timestamp())
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states->'capture_listing'->>'status'='complete'
        when 'baseline_checks' then run.stage_states->'normalize_identity'->>'status'='complete'
        when 'research' then run.stage_states->'baseline_checks'->>'status'='complete'
        when 'enrich' then run.stage_states->'baseline_checks'->>'status'='complete' and coalesce(run.stage_states->'research'->>'status','queued') in ('complete','unavailable')
        when 'assemble_report' then run.stage_states->'baseline_checks'->>'status'='complete' and ((run.trigger='initial' and not (run.stage_states ? 'assemble_report')) or not exists (select 1 from public.analysis_jobs predecessor where predecessor.run_id=job.run_id and predecessor.stage in ('normalize_identity','baseline_checks','research','enrich') and predecessor.status in ('queued','leased')))
        else false end
    order by run.created_at,
      (job.stage='assemble_report' and run.trigger='initial' and not (run.stage_states ? 'assemble_report')) desc,
      job.available_at,array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'],job.stage),job.created_at
    for update of job skip locked limit 1
  ) update public.analysis_jobs job set status='leased',attempts=job.attempts+1,leased_by=worker_id,
    lease_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds),completed_at=null
  from candidate where job.id=candidate.id returning job.*;
end;
$$;



drop function public.reuse_committed_pdf_reviews(uuid,uuid,uuid,text,uuid,uuid,uuid);
drop function public.review_run_is_live(uuid,uuid);
alter table public.review_executions drop column reused_from_execution_id;
alter table public.analysis_runs drop column review_reuse_run_id;
