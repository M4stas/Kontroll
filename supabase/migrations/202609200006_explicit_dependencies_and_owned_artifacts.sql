-- Makes the partial-report dependency explicit and gives replayed artifacts a
-- stage owner. Existing rows remain readable: producer_stage is additive.

alter table public.source_snapshots add column if not exists producer_stage text;
alter table public.vehicle_facts add column if not exists producer_stage text;
alter table public.evidence add column if not exists producer_stage text;

create index if not exists source_snapshots_owned_stage_idx
  on public.source_snapshots (analysis_id, run_id, producer_stage)
  where producer_stage is not null;
create index if not exists vehicle_facts_owned_stage_idx
  on public.vehicle_facts (analysis_id, run_id, producer_stage)
  where producer_stage is not null;
create index if not exists evidence_owned_stage_idx
  on public.evidence (analysis_id, run_id, producer_stage)
  where producer_stage is not null;

create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if worker_id is null or length(btrim(worker_id)) = 0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;

  return query
  with candidate as (
    select job.id
    from public.analysis_jobs as job
    join public.analysis_runs as run on run.id = job.run_id and run.analysis_id = job.analysis_id
    where job.available_at <= clock_timestamp()
      and (job.status = 'queued' or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp()))
      and not exists (
        select 1 from public.analysis_jobs as active
        where active.run_id = job.run_id and active.status = 'leased' and active.lease_expires_at > clock_timestamp()
      )
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states -> 'capture_listing' ->> 'status' = 'complete'
        when 'baseline_checks' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'research' then run.stage_states -> 'normalize_identity' ->> 'status' = 'complete'
        when 'enrich' then (
          run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
          and coalesce(run.stage_states -> 'research' ->> 'status', 'queued') in ('complete', 'unavailable', 'failed')
        )
        when 'assemble_report' then (
          run.stage_states -> 'baseline_checks' ->> 'status' = 'complete'
          and (
            -- The first initial assembly is deliberately readable before optional work.
            (run.trigger = 'initial' and not (run.stage_states ? 'assemble_report'))
            -- Every later assembly, including every supplement assembly, waits for
            -- all invalidated predecessors even while a retry is backing off.
            or not exists (
              select 1 from public.analysis_jobs as predecessor
              where predecessor.run_id = job.run_id
                and predecessor.stage in ('normalize_identity', 'baseline_checks', 'research', 'enrich')
                and predecessor.status in ('queued', 'leased')
            )
          )
        )
        else false
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
  from candidate where job.id = candidate.id returning job.*;
end;
$$;

create or replace function public.save_stage_source_snapshots(
  p_sources jsonb, p_analysis_id uuid, p_run_id uuid, p_stage text
) returns table (snapshot_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_id uuid;
begin
  if jsonb_typeof(p_sources) <> 'array' then raise exception 'sources must be a JSON array'; end if;
  if p_stage not in ('capture_listing', 'research') then raise exception 'invalid source producer stage'; end if;
  if exists (select 1 from jsonb_array_elements(p_sources) item where (item->>'analysis_id')::uuid <> p_analysis_id or (item->>'run_id')::uuid <> p_run_id) then
    raise exception 'source ownership does not match target run';
  end if;
  delete from public.source_snapshots stale
  where stale.analysis_id = p_analysis_id and stale.run_id = p_run_id and stale.producer_stage = p_stage
    and not exists (select 1 from jsonb_array_elements(p_sources) incoming where (incoming->>'id')::uuid = stale.id);
  for v_item in select value from jsonb_array_elements(p_sources) loop
    v_id := (v_item->>'id')::uuid;
    insert into public.source_snapshots (id, analysis_id, run_id, source_type, source_url, captured_at, content_hash, storage_key, extraction_status, metadata, producer_stage)
    values (v_id, p_analysis_id, p_run_id, v_item->>'source_type', nullif(v_item->>'source_url',''), coalesce((v_item->>'captured_at')::timestamptz, clock_timestamp()), nullif(v_item->>'content_hash',''), nullif(v_item->>'storage_key',''), coalesce(nullif(v_item->>'extraction_status','')::public.stage_status, 'queued'), coalesce(v_item->'metadata','{}'::jsonb), p_stage)
    on conflict (id) do update set source_type=excluded.source_type, source_url=excluded.source_url, captured_at=excluded.captured_at, content_hash=excluded.content_hash, storage_key=excluded.storage_key, extraction_status=excluded.extraction_status, metadata=excluded.metadata, producer_stage=excluded.producer_stage
    where public.source_snapshots.analysis_id=excluded.analysis_id and public.source_snapshots.run_id=excluded.run_id;
    if not found then raise exception 'source snapshot id belongs to another analysis run'; end if;
    snapshot_id := v_id; return next;
  end loop;
end;
$$;

create or replace function public.save_stage_vehicle_facts(
  p_facts jsonb, p_analysis_id uuid, p_run_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_id uuid;
begin
  if jsonb_typeof(p_facts) <> 'array' then raise exception 'facts must be a JSON array'; end if;
  if exists (select 1 from jsonb_array_elements(p_facts) item where (item->>'analysis_id')::uuid <> p_analysis_id or (item->>'run_id')::uuid <> p_run_id) then raise exception 'fact ownership does not match target run'; end if;
  delete from public.vehicle_facts stale where stale.analysis_id=p_analysis_id and stale.run_id=p_run_id and stale.producer_stage='normalize_identity'
    and not exists (select 1 from jsonb_array_elements(p_facts) incoming where (incoming->>'id')::uuid=stale.id);
  for v_item in select value from jsonb_array_elements(p_facts) loop
    v_id := (v_item->>'id')::uuid;
    insert into public.vehicle_facts (id,analysis_id,run_id,fact_key,fact_value,normalized_value,source_snapshot_id,verification,match_confidence,producer_stage)
    values (v_id,p_analysis_id,p_run_id,v_item->>'fact_key',v_item->>'fact_value',nullif(v_item->>'normalized_value',''),(v_item->>'source_snapshot_id')::uuid,(v_item->>'verification')::public.verification_state,(v_item->>'match_confidence')::double precision,'normalize_identity')
    on conflict (id) do update set fact_key=excluded.fact_key,fact_value=excluded.fact_value,normalized_value=excluded.normalized_value,source_snapshot_id=excluded.source_snapshot_id,verification=excluded.verification,match_confidence=excluded.match_confidence,producer_stage=excluded.producer_stage
    where public.vehicle_facts.analysis_id=excluded.analysis_id and public.vehicle_facts.run_id=excluded.run_id;
    if not found then raise exception 'vehicle fact id belongs to another analysis run'; end if;
  end loop;
end;
$$;

create or replace function public.save_stage_evidence(
  p_evidence jsonb, p_analysis_id uuid, p_run_id uuid, p_stage text
) returns table (evidence_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_id uuid;
begin
  if jsonb_typeof(p_evidence) <> 'array' then raise exception 'evidence must be a JSON array'; end if;
  if p_stage not in ('baseline_checks','enrich') then raise exception 'invalid evidence producer stage'; end if;
  if exists (select 1 from jsonb_array_elements(p_evidence) item where (item->>'analysis_id')::uuid <> p_analysis_id or (item->>'run_id')::uuid <> p_run_id) then raise exception 'evidence ownership does not match target run'; end if;
  delete from public.evidence stale where stale.analysis_id=p_analysis_id and stale.run_id=p_run_id and stale.producer_stage=p_stage
    and not exists (select 1 from jsonb_array_elements(p_evidence) incoming where (incoming->>'id')::uuid=stale.id);
  for v_item in select value from jsonb_array_elements(p_evidence) loop
    v_id := (v_item->>'id')::uuid;
    insert into public.evidence (id,analysis_id,run_id,source_snapshot_id,source_class,claim,applicability,confidence,verification,captured_at,producer_stage)
    values (v_id,p_analysis_id,p_run_id,(v_item->>'source_snapshot_id')::uuid,v_item->>'source_class',v_item->>'claim',v_item->>'applicability',(v_item->>'confidence')::double precision,(v_item->>'verification')::public.verification_state,coalesce((v_item->>'captured_at')::timestamptz,clock_timestamp()),p_stage)
    on conflict (id) do update set source_snapshot_id=excluded.source_snapshot_id,source_class=excluded.source_class,claim=excluded.claim,applicability=excluded.applicability,confidence=excluded.confidence,verification=excluded.verification,captured_at=excluded.captured_at,producer_stage=excluded.producer_stage
    where public.evidence.analysis_id=excluded.analysis_id and public.evidence.run_id=excluded.run_id;
    if not found then raise exception 'evidence id belongs to another analysis run'; end if;
    evidence_id:=v_id; return next;
  end loop;
end;
$$;

revoke execute on function public.lease_analysis_job(text,int), public.save_stage_source_snapshots(jsonb,uuid,uuid,text), public.save_stage_vehicle_facts(jsonb,uuid,uuid), public.save_stage_evidence(jsonb,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text,int), public.save_stage_source_snapshots(jsonb,uuid,uuid,text), public.save_stage_vehicle_facts(jsonb,uuid,uuid), public.save_stage_evidence(jsonb,uuid,uuid,text) to service_role;
