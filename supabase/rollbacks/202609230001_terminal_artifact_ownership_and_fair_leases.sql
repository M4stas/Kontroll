-- Apply after rolling application code back. Artifact rows and run state remain.
drop trigger if exists finding_evidence_ownership on public.finding_evidence;
drop trigger if exists actions_ownership on public.actions;
drop trigger if exists findings_ownership on public.findings;
drop trigger if exists evidence_ownership on public.evidence;
drop trigger if exists vehicle_facts_ownership on public.vehicle_facts;
drop trigger if exists source_snapshots_ownership on public.source_snapshots;
drop function if exists public.assert_analysis_artifact_ownership();

drop function if exists public.save_findings(jsonb,uuid,uuid);
drop function if exists public.save_actions(jsonb,uuid,uuid);
alter function public.save_findings_unchecked(jsonb,uuid,uuid) rename to save_findings;
alter function public.save_actions_unchecked(jsonb,uuid,uuid) rename to save_actions;
grant execute on function public.save_findings(jsonb,uuid,uuid), public.save_actions(jsonb,uuid,uuid) to service_role;

create or replace function public.fail_analysis_job(p_job_id uuid,p_worker_id text,p_message text)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.analysis_jobs;
begin
  update public.analysis_jobs job set status='failed',completed_at=clock_timestamp(),leased_by=null,
    lease_expires_at=null,last_error=jsonb_build_object('message',p_message)
  where job.id=p_job_id and job.status='leased' and job.leased_by=p_worker_id
    and job.lease_expires_at>clock_timestamp() returning job.* into v_job;
  if not found then raise exception 'analysis job active lease not found for worker'; end if;
  return next v_job;
end;
$$;

-- Restore 008's lease order and dependency rules.
create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
begin
  if worker_id is null or length(btrim(worker_id))=0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds<1 or lease_seconds>3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;
  return query with candidate as (
    select job.id from public.analysis_jobs job join public.analysis_runs run on run.id=job.run_id and run.analysis_id=job.analysis_id
    where job.available_at<=clock_timestamp() and (job.status='queued' or (job.status='leased' and job.lease_expires_at<=clock_timestamp()))
      and not exists (select 1 from public.analysis_jobs active where active.run_id=job.run_id and active.status='leased' and active.lease_expires_at>clock_timestamp())
      and case job.stage
        when 'capture_listing' then true
        when 'normalize_identity' then run.stage_states->'capture_listing'->>'status'='complete'
        when 'baseline_checks' then run.stage_states->'normalize_identity'->>'status'='complete'
        when 'research' then run.stage_states->'baseline_checks'->>'status'='complete'
        when 'enrich' then run.stage_states->'baseline_checks'->>'status'='complete' and coalesce(run.stage_states->'research'->>'status','queued') in ('complete','unavailable','failed')
        when 'assemble_report' then run.stage_states->'baseline_checks'->>'status'='complete' and ((run.trigger='initial' and not (run.stage_states ? 'assemble_report')) or not exists (select 1 from public.analysis_jobs predecessor where predecessor.run_id=job.run_id and predecessor.stage in ('normalize_identity','baseline_checks','research','enrich') and predecessor.status in ('queued','leased')))
        else false end
    order by (job.stage='assemble_report' and run.trigger='initial' and not (run.stage_states ? 'assemble_report')) desc,
      job.available_at,array_position(array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'],job.stage),job.created_at
    for update of job skip locked limit 1
  ) update public.analysis_jobs job set status='leased',attempts=job.attempts+1,leased_by=worker_id,
    lease_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds),completed_at=null
  from candidate where job.id=candidate.id returning job.*;
end;
$$;
