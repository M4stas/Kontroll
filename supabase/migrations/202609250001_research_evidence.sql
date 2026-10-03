-- Research evidence is owned by the research stage and must not overwrite baseline or enrichment evidence.
create or replace function public.save_research_evidence(
  p_evidence jsonb, p_analysis_id uuid, p_run_id uuid
) returns table (evidence_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_id uuid;
begin
  if jsonb_typeof(p_evidence) <> 'array' then raise exception 'evidence must be a JSON array'; end if;
  if exists (select 1 from jsonb_array_elements(p_evidence) item
    where (item->>'analysis_id')::uuid <> p_analysis_id or (item->>'run_id')::uuid <> p_run_id) then
    raise exception 'evidence ownership does not match target run';
  end if;
  delete from public.evidence stale where stale.analysis_id=p_analysis_id and stale.run_id=p_run_id
    and stale.producer_stage='research'
    and not exists (select 1 from jsonb_array_elements(p_evidence) incoming where (incoming->>'id')::uuid=stale.id);
  for v_item in select value from jsonb_array_elements(p_evidence) loop
    v_id := (v_item->>'id')::uuid;
    insert into public.evidence
      (id,analysis_id,run_id,source_snapshot_id,source_class,claim,applicability,confidence,verification,captured_at,producer_stage)
    values
      (v_id,p_analysis_id,p_run_id,(v_item->>'source_snapshot_id')::uuid,v_item->>'source_class',v_item->>'claim',
       v_item->>'applicability',(v_item->>'confidence')::double precision,
       (v_item->>'verification')::public.verification_state,
       coalesce((v_item->>'captured_at')::timestamptz,clock_timestamp()),'research')
    on conflict (id) do update set source_snapshot_id=excluded.source_snapshot_id,source_class=excluded.source_class,
      claim=excluded.claim,applicability=excluded.applicability,confidence=excluded.confidence,
      verification=excluded.verification,captured_at=excluded.captured_at,producer_stage=excluded.producer_stage
    where public.evidence.analysis_id=excluded.analysis_id and public.evidence.run_id=excluded.run_id;
    if not found then raise exception 'research evidence id belongs to another analysis run'; end if;
    evidence_id:=v_id; return next;
  end loop;
end;
$$;

revoke execute on function public.save_research_evidence(jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.save_research_evidence(jsonb,uuid,uuid) to service_role;

-- Enrichment may register model-proposed citations, owned separately from capture/research snapshots.
create or replace function public.save_enrich_source_snapshots(
  p_sources jsonb, p_analysis_id uuid, p_run_id uuid
) returns table (snapshot_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_id uuid;
begin
  if jsonb_typeof(p_sources) <> 'array' then raise exception 'sources must be a JSON array'; end if;
  if exists (select 1 from jsonb_array_elements(p_sources) item
    where (item->>'analysis_id')::uuid <> p_analysis_id or (item->>'run_id')::uuid <> p_run_id) then
    raise exception 'source ownership does not match target run';
  end if;
  delete from public.source_snapshots stale where stale.analysis_id=p_analysis_id and stale.run_id=p_run_id
    and stale.producer_stage='enrich'
    and not exists (select 1 from jsonb_array_elements(p_sources) incoming where (incoming->>'id')::uuid=stale.id);
  for v_item in select value from jsonb_array_elements(p_sources) loop
    v_id := (v_item->>'id')::uuid;
    insert into public.source_snapshots
      (id,analysis_id,run_id,source_type,source_url,captured_at,content_hash,storage_key,extraction_status,metadata,producer_stage)
    values
      (v_id,p_analysis_id,p_run_id,v_item->>'source_type',nullif(v_item->>'source_url',''),
       coalesce((v_item->>'captured_at')::timestamptz,clock_timestamp()),nullif(v_item->>'content_hash',''),
       nullif(v_item->>'storage_key',''),
       coalesce(nullif(v_item->>'extraction_status','')::public.stage_status,'queued'),
       coalesce(v_item->'metadata','{}'::jsonb),'enrich')
    on conflict (id) do update set source_type=excluded.source_type,source_url=excluded.source_url,
      captured_at=excluded.captured_at,content_hash=excluded.content_hash,storage_key=excluded.storage_key,
      extraction_status=excluded.extraction_status,metadata=excluded.metadata,producer_stage=excluded.producer_stage
    where public.source_snapshots.analysis_id=excluded.analysis_id and public.source_snapshots.run_id=excluded.run_id;
    if not found then raise exception 'enrich source id belongs to another analysis run'; end if;
    snapshot_id:=v_id; return next;
  end loop;
end;
$$;

revoke execute on function public.save_enrich_source_snapshots(jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.save_enrich_source_snapshots(jsonb,uuid,uuid) to service_role;
