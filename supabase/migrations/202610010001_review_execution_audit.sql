-- Durable, service-only audit records for provider-independent review passes.
create extension if not exists pgcrypto with schema extensions;

create table public.review_run_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (analysis_id, run_id),
  unique (id, analysis_id, run_id)
);

create table public.review_executions (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  snapshot_id uuid not null,
  pass text not null check (pass in ('text', 'image', 'final')),
  image_evidence_id uuid,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  evidence_ids uuid[] not null default '{}',
  prior_execution_ids uuid[] not null default '{}',
  prior_result_hashes jsonb not null default '[]'::jsonb check (jsonb_typeof(prior_result_hashes) = 'array'),
  request_projection jsonb not null check (jsonb_typeof(request_projection) = 'object'),
  result jsonb,
  result_hash text check (result_hash is null or result_hash ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (snapshot_id, analysis_id, run_id)
    references public.review_run_snapshots(id, analysis_id, run_id) on delete cascade,
  check ((pass = 'image') = (image_evidence_id is not null)),
  check ((result is null) = (result_hash is null)),
  check ((result is null) = (completed_at is null)),
  check (cardinality(evidence_ids) <= 256),
  check (cardinality(prior_execution_ids) <= 65),
  unique (analysis_id, run_id, fingerprint),
  unique (id, analysis_id, run_id)
);

create unique index review_executions_one_scheduled_pass_idx
  on public.review_executions (
    analysis_id,
    run_id,
    pass,
    coalesce(image_evidence_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create table public.review_attempts (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  execution_id uuid not null references public.review_executions(id) on delete cascade,
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  worker_id text not null check (length(btrim(worker_id)) between 1 and 128),
  job_lease_attempt integer not null check (job_lease_attempt > 0),
  attempt_number integer not null check (attempt_number > 0),
  state text not null default 'started' check (state in ('started', 'success', 'failure', 'unavailable', 'lost')),
  warning_code text check (warning_code is null or warning_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 128),
  result_hash text check (result_hash is null or result_hash ~ '^[a-f0-9]{64}$'),
  publication_hash text check (publication_hash is null or publication_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (execution_id, analysis_id, run_id)
    references public.review_executions(id, analysis_id, run_id) on delete cascade,
  unique (execution_id, attempt_number),
  check ((state = 'started') = (completed_at is null)),
  check ((state = 'success') = (result_hash is not null))
);

create index review_executions_run_idx on public.review_executions (analysis_id, run_id, created_at);
create index review_attempts_run_idx on public.review_attempts (analysis_id, run_id, execution_id, attempt_number);

create or replace function public.review_audit_json_safe(p_value jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_child jsonb;
  v_text text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      for v_key, v_child in select key, value from jsonb_each(p_value) loop
        if (v_key <> 'maxOutputTokens' and v_key ~* '(api.?key|credential|secret|access.?token|capability|signed.?url|authorization|bearer|signature|token|password)')
          or not public.review_audit_json_safe(v_child) then
          return false;
        end if;
      end loop;
      return true;
    when 'array' then
      for v_child in select value from jsonb_array_elements(p_value) loop
        if not public.review_audit_json_safe(v_child) then return false; end if;
      end loop;
      return true;
    when 'string' then
      v_text := p_value #>> '{}';
      return v_text !~* '\mBearer\s+[^\s]+'
        and v_text !~* '\msk-(proj-)?[A-Za-z0-9_-]{16,}\M'
        and v_text !~* 'https?://[^[:space:]<>"'']+[?&](token|access_token|signature|sig|x-amz-signature|x-goog-signature)=';
    else
      return true;
  end case;
end;
$$;

-- Lock order is shared by every audit RPC and supplement creation: analysis,
-- run, then the enrich job. The analysis row serializes superseding submissions.
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

create or replace function public.review_citation_uuid(p_value text)
returns uuid
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_variant integer;
begin
  v_hash := encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex');
  v_variant := (((get_byte(decode(v_hash, 'hex'), 8) >> 4) & 3) | 8);
  return (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-5' || substr(v_hash, 14, 3)
    || '-' || substr('0123456789abcdef', v_variant + 1, 1) || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid;
end;
$$;

create or replace function public.review_evidence_is_owned(p_analysis_id uuid, p_run_id uuid, p_evidence jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence_id uuid;
  v_source_id uuid;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) is distinct from 'object'
    or not (p_evidence ?& array['id','sourceId'])
    or jsonb_typeof(p_evidence->'id') is distinct from 'string'
    or jsonb_typeof(p_evidence->'sourceId') is distinct from 'string'
    or (p_evidence->>'id') !~* '^[0-9a-f-]{36}$'
    or (p_evidence->>'sourceId') !~* '^[0-9a-f-]{36}$' then return false; end if;
  v_evidence_id := (p_evidence->>'id')::uuid;
  v_source_id := (p_evidence->>'sourceId')::uuid;

  if exists (
    with recursive lineage(id, parent_run_id) as (
      select run.id, run.parent_run_id from public.analysis_runs run
      where run.id = p_run_id and run.analysis_id = p_analysis_id
      union all
      select parent.id, parent.parent_run_id from public.analysis_runs parent
      join lineage child on child.parent_run_id = parent.id and parent.analysis_id = p_analysis_id
    )
    select 1 from public.evidence evidence
    join public.source_snapshots source on source.id = evidence.source_snapshot_id and source.analysis_id = p_analysis_id
    join lineage as evidence_run on evidence_run.id = evidence.run_id
    join lineage as source_run on source_run.id = source.run_id
    where evidence.id = v_evidence_id and evidence.analysis_id = p_analysis_id
      and evidence.source_snapshot_id = v_source_id
  ) then return true; end if;

  return exists (
    with recursive lineage(id, parent_run_id) as (
      select run.id, run.parent_run_id from public.analysis_runs run
      where run.id = p_run_id and run.analysis_id = p_analysis_id
      union all
      select parent.id, parent.parent_run_id from public.analysis_runs parent
      join lineage child on child.parent_run_id = parent.id and parent.analysis_id = p_analysis_id
    )
    select 1 from public.submissions submission
    join public.source_snapshots source on source.id = submission.source_snapshot_id
      and source.analysis_id = p_analysis_id and source.run_id = submission.run_id
    join lineage on lineage.id = submission.run_id
    where submission.analysis_id = p_analysis_id
      and public.review_citation_uuid(p_analysis_id::text || ':' || submission.run_id::text || ':supplement:' || submission.id::text) = v_evidence_id
      and submission.source_snapshot_id = v_source_id
  );
end;
$$;

create or replace function public.review_image_is_owned(
  p_analysis_id uuid,
  p_run_id uuid,
  p_evidence_id uuid,
  p_status text,
  p_storage_key text,
  p_content_hash text,
  p_mime_type text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with recursive lineage(id, parent_run_id) as (
    select run.id, run.parent_run_id from public.analysis_runs run
    where run.id = p_run_id and run.analysis_id = p_analysis_id
    union all
    select parent.id, parent.parent_run_id from public.analysis_runs parent
    join lineage child on child.parent_run_id = parent.id and parent.analysis_id = p_analysis_id
  )
  select coalesce(
    p_status = 'accepted'
    and p_storage_key is not null
    and p_content_hash ~ '^[a-f0-9]{64}$'
    and p_mime_type in ('image/jpeg','image/png','image/webp')
    and (
      exists (
        select 1 from lineage
        join public.analysis_runs run on run.id = lineage.id and run.analysis_id = p_analysis_id
        cross join lateral jsonb_array_elements(coalesce(
          run.stage_states #> '{capture_listing,output,snapshot,photoPreparation,images}', '[]'::jsonb
        )) as photo(value)
        where photo.value->>'evidenceId' = p_evidence_id::text
          and photo.value->>'status' = p_status
          and photo.value->>'storageKey' = p_storage_key
          and photo.value->>'contentHash' = p_content_hash
          and photo.value->>'mimeType' = p_mime_type
      ) or exists (
        select 1 from public.submissions submission
        join lineage on lineage.id = submission.run_id
        join public.source_snapshots source on source.id = submission.source_snapshot_id
          and source.analysis_id = p_analysis_id and source.run_id = submission.run_id
        where submission.analysis_id = p_analysis_id
          and submission.kind in ('image', 'screenshot')
          and public.review_citation_uuid(p_analysis_id::text || ':' || submission.run_id::text || ':supplement:' || submission.id::text) = p_evidence_id
          and submission.storage_key = p_storage_key
          and submission.mime_type = p_mime_type
      )
    ), false
  );
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

create or replace function public.review_barrier_matches(
  p_analysis_id uuid,
  p_run_id uuid,
  p_snapshot_id uuid,
  p_prior_execution_ids uuid[],
  p_prior_result_hashes jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_expected_ids uuid[] := '{}';
  v_expected_hashes jsonb := '[]'::jsonb;
  v_execution_id uuid;
  v_hash text;
  v_image jsonb;
begin
  select snapshot into v_snapshot from public.review_run_snapshots
  where id = p_snapshot_id and analysis_id = p_analysis_id and run_id = p_run_id;
  if not found then return false; end if;

  select id, result_hash into v_execution_id, v_hash from public.review_executions
  where analysis_id = p_analysis_id and run_id = p_run_id and pass = 'text' and result_hash is not null;
  if not found then return false; end if;
  v_expected_ids := array_append(v_expected_ids, v_execution_id);
  v_expected_hashes := v_expected_hashes || jsonb_build_array(jsonb_build_object('executionId', v_execution_id, 'resultHash', v_hash));

  for v_image in select value from jsonb_array_elements(v_snapshot->'imageManifest'->'images') with ordinality as images(value, ordinal)
    where value->>'selected' = 'true' order by ordinal
  loop
    if v_image->>'status' <> 'accepted' then return false; end if;
    select id, result_hash into v_execution_id, v_hash from public.review_executions
    where analysis_id = p_analysis_id and run_id = p_run_id and pass = 'image'
      and image_evidence_id = (v_image->>'evidenceId')::uuid and result_hash is not null;
    if not found then return false; end if;
    v_expected_ids := array_append(v_expected_ids, v_execution_id);
    v_expected_hashes := v_expected_hashes || jsonb_build_array(jsonb_build_object('executionId', v_execution_id, 'resultHash', v_hash));
  end loop;

  return coalesce(p_prior_execution_ids, '{}') = v_expected_ids
    and coalesce(p_prior_result_hashes, '[]'::jsonb) = v_expected_hashes;
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

create or replace function public.start_review_attempt(
  p_analysis_id uuid,
  p_run_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_execution_id uuid
)
returns table (attempt_id uuid, attempt_number integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_attempt integer;
  v_execution public.review_executions%rowtype;
  v_attempt_number integer;
begin
  v_lease_attempt := public.review_assert_live_lease(p_analysis_id, p_run_id, p_job_id, p_worker_id);
  select * into v_execution from public.review_executions
  where id = p_execution_id and analysis_id = p_analysis_id and run_id = p_run_id
  for update;
  if not found then raise exception 'review execution does not belong to this run'; end if;
  if v_execution.result_hash is not null then raise exception 'committed review execution cannot be called again'; end if;

  update public.review_attempts set state = 'lost', warning_code = 'lease_lost', completed_at = clock_timestamp()
  where execution_id = p_execution_id and state = 'started' and job_lease_attempt < v_lease_attempt;
  if exists (select 1 from public.review_attempts where execution_id = p_execution_id
    and state = 'started' and job_lease_attempt = v_lease_attempt) then
    raise exception 'review attempt is already active for this enrich lease';
  end if;
  select coalesce(max(attempt.attempt_number), 0) + 1 into v_attempt_number
  from public.review_attempts as attempt where attempt.execution_id = p_execution_id;
  insert into public.review_attempts (
    analysis_id, run_id, execution_id, job_id, worker_id, job_lease_attempt, attempt_number
  ) values (
    p_analysis_id, p_run_id, p_execution_id, p_job_id, p_worker_id, v_lease_attempt, v_attempt_number
  ) returning id into attempt_id;
  attempt_number := v_attempt_number;
  return next;
end;
$$;

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
      if p_pass = 'image' and v_id::uuid is distinct from p_image_evidence_id then return false; end if;
    end loop;
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
      or p_publication->>'status' is null or p_publication->>'status' not in ('partial','complete')
      or (jsonb_typeof(p_publication->'verdict') is distinct from 'string' and jsonb_typeof(p_publication->'verdict') is distinct from 'null')
      or (p_publication->>'verdict' is not null and p_publication->>'verdict' not in ('worth_viewing','proceed_cautiously','likely_skip'))
      or (jsonb_typeof(p_publication->'confidence') is distinct from 'string' and jsonb_typeof(p_publication->'confidence') is distinct from 'null')
      or (p_publication->>'confidence' is not null and p_publication->>'confidence' not in ('low','moderate','high'))
      or (p_publication->>'completed_at') is null
      or jsonb_typeof(p_publication->'findings') is distinct from 'array' or jsonb_array_length(p_publication->'findings') > 256
      or jsonb_typeof(p_publication->'actions') is distinct from 'array' or jsonb_array_length(p_publication->'actions') > 256 then
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
        or length(coalesce(v_finding->>'next_action','')) > 4000
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
        or length(coalesce(v_action->>'title','')) > 4000 or length(coalesce(v_action->>'instructions','')) > 4000
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
    perform finding_id from public.save_findings(p_publication->'findings', p_analysis_id, p_run_id);
    perform action_id from public.save_actions(p_publication->'actions', p_analysis_id, p_run_id);
    if not public.finalize_analysis_report(
      p_analysis_id, p_run_id, p_publication->'assembly_result', v_status,
      p_publication->>'verdict', p_publication->>'confidence', (p_publication->>'completed_at')::timestamptz
    ) then raise exception 'review run is no longer current'; end if;
  end if;
end;
$$;

-- Browser and authenticated clients cannot observe or mutate the private audit.
-- The service role can read through PostgREST; all writes happen in the RPCs.
alter table public.review_run_snapshots enable row level security;
alter table public.review_executions enable row level security;
alter table public.review_attempts enable row level security;
revoke all on public.review_run_snapshots, public.review_executions, public.review_attempts from public, anon, authenticated, service_role;
grant select on public.review_run_snapshots, public.review_executions, public.review_attempts to service_role;

revoke all on function public.review_audit_json_safe(jsonb),
  public.review_citation_uuid(text),
  public.review_evidence_is_owned(uuid,uuid,jsonb),
  public.review_image_is_owned(uuid,uuid,uuid,text,text,text,text),
  public.review_assert_live_lease(uuid,uuid,uuid,text),
  public.review_barrier_matches(uuid,uuid,uuid,uuid[],jsonb),
  public.review_result_is_valid(jsonb,text,uuid,uuid[]),
  public.pin_review_run_snapshot(uuid,uuid,uuid,text,text,jsonb),
  public.ensure_review_execution(uuid,uuid,uuid,text,uuid,text,uuid,text,uuid[],jsonb,uuid[],jsonb),
  public.start_review_attempt(uuid,uuid,uuid,text,uuid),
  public.commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.pin_review_run_snapshot(uuid,uuid,uuid,text,text,jsonb),
  public.ensure_review_execution(uuid,uuid,uuid,text,uuid,text,uuid,text,uuid[],jsonb,uuid[],jsonb),
  public.start_review_attempt(uuid,uuid,uuid,text,uuid),
  public.commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)
to service_role;

comment on table public.review_run_snapshots is 'Immutable private source/config/prompt/image snapshot pinned before any review pass.';
comment on table public.review_executions is 'Immutable per-pass request identity and committed validated result for a pinned run.';
comment on table public.review_attempts is 'Append-only provider-call attempts; successful results are committed atomically with their attempt.';
comment on function public.commit_review_attempt(uuid,uuid,uuid,text,uuid,text,jsonb,text,text,jsonb)
  is 'Commits a review attempt under the live current enrich lease; final success and complete report publication share one transaction.';
