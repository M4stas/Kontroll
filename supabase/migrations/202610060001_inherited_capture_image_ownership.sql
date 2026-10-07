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
        where (
          photo.value->>'evidenceId' = p_evidence_id::text
          or exists (
            -- A baseline rerun gives inherited capture citations new identities.
            -- Bind that identity to canonical lineage evidence and the original
            -- captured source; the original photo still proves the exact bytes.
            select 1 from public.evidence evidence
            join lineage citation_run on citation_run.id = evidence.run_id
            where evidence.id = p_evidence_id
              and evidence.analysis_id = p_analysis_id
              and evidence.source_snapshot_id::text = run.stage_states #>> '{capture_listing,output,snapshot,sourceId}'
              and public.review_citation_uuid(p_analysis_id::text || ':' || evidence.run_id::text || ':capture-citation:' || (photo.value->>'evidenceId')) = p_evidence_id
          )
        )
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

