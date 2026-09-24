-- Task 12 round 4: terminal optional stages, artifact ownership, and fair leasing.
-- Existing rows are left intact; only functions and triggers are added/replaced.

create or replace function public.fail_analysis_job(p_job_id uuid, p_worker_id text, p_message text)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.analysis_jobs; v_warning text;
begin
  update public.analysis_jobs as job
  set status='failed', completed_at=clock_timestamp(), leased_by=null, lease_expires_at=null,
      last_error=jsonb_build_object('message',p_message)
  where job.id=p_job_id and job.status='leased' and job.leased_by=p_worker_id
    and job.lease_expires_at>clock_timestamp()
  returning job.* into v_job;
  if not found then raise exception 'analysis job active lease not found for worker'; end if;
  if v_job.stage in ('research','enrich') then
    v_warning := v_job.stage || '_unavailable';
    update public.analysis_runs as run
    set stage_states=run.stage_states || jsonb_build_object(v_job.stage,
      jsonb_build_object('version',1,'status','unavailable',
        'output',case when v_job.stage='research' then jsonb_build_object('sourceStates','{}'::jsonb)
          else jsonb_build_object('evidence','[]'::jsonb,'findings','[]'::jsonb,'actions','[]'::jsonb) end,
        'warnings',jsonb_build_array(v_warning),'completedAt',clock_timestamp()))
    where run.id=v_job.run_id and run.analysis_id=v_job.analysis_id;
  end if;
  return next v_job;
end;
$$;

-- Validate the row and every referenced artifact, including direct service-role
-- writes. Ancestor evidence/sources are valid for cumulative supplement runs.
create function public.assert_analysis_artifact_ownership()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_analysis uuid; v_run uuid; v_reference uuid;
begin
  if tg_table_name='finding_evidence' then
    select f.analysis_id,f.run_id into v_analysis,v_run from public.findings f where f.id=new.finding_id;
    select e.run_id into v_reference from public.evidence e where e.id=new.evidence_id and e.analysis_id=v_analysis;
    if v_reference is null then raise exception 'finding evidence belongs to another analysis'; end if;
  else
    v_analysis:=new.analysis_id; v_run:=new.run_id;
    if not exists (select 1 from public.analysis_runs r where r.id=v_run and r.analysis_id=v_analysis) then
      raise exception 'artifact run belongs to another analysis';
    end if;
    if tg_table_name in ('vehicle_facts','evidence') then
      select s.run_id into v_reference from public.source_snapshots s
      where s.id=new.source_snapshot_id and s.analysis_id=v_analysis;
      if v_reference is null then raise exception 'source belongs to another analysis'; end if;
    elsif tg_table_name='actions' then
      if new.finding_id is not null and not exists (select 1 from public.findings f where f.id=new.finding_id
        and f.analysis_id=v_analysis and f.run_id=v_run) then
        raise exception 'action finding belongs to another analysis run';
      end if;
    end if;
  end if;
  if v_reference is not null and not exists (
    with recursive ancestors as (
      select r.id,r.parent_run_id from public.analysis_runs r where r.id=v_run and r.analysis_id=v_analysis
      union all
      select parent.id,parent.parent_run_id from public.analysis_runs parent
      join ancestors child on parent.id=child.parent_run_id and parent.analysis_id=v_analysis
    ) select 1 from ancestors where id=v_reference
  ) then raise exception 'artifact reference is outside the analysis run lineage'; end if;
  return new;
end;
$$;

create trigger source_snapshots_ownership before insert or update on public.source_snapshots
for each row execute function public.assert_analysis_artifact_ownership();
create trigger vehicle_facts_ownership before insert or update on public.vehicle_facts
for each row execute function public.assert_analysis_artifact_ownership();
create trigger evidence_ownership before insert or update on public.evidence
for each row execute function public.assert_analysis_artifact_ownership();
create trigger findings_ownership before insert or update on public.findings
for each row execute function public.assert_analysis_artifact_ownership();
create trigger actions_ownership before insert or update on public.actions
for each row execute function public.assert_analysis_artifact_ownership();
create trigger finding_evidence_ownership before insert or update on public.finding_evidence
for each row execute function public.assert_analysis_artifact_ownership();

-- Preserve the existing implementation behind checked entry points. These
-- wrappers validate replacement scope before the underlying stale-set delete.
alter function public.save_findings(jsonb,uuid,uuid) rename to save_findings_unchecked;
alter function public.save_actions(jsonb,uuid,uuid) rename to save_actions_unchecked;

create function public.save_findings(p_findings jsonb, p_replace_analysis_id uuid default null, p_replace_run_id uuid default null)
returns table(finding_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then raise exception 'replacement scope must be complete'; end if;
  if p_replace_run_id is not null and not exists (select 1 from public.analysis_runs r
    where r.id=p_replace_run_id and r.analysis_id=p_replace_analysis_id) then raise exception 'replacement run belongs to another analysis'; end if;
  if p_replace_run_id is not null and exists (select 1 from jsonb_array_elements(p_findings) item
    where (item->>'analysis_id')::uuid is distinct from p_replace_analysis_id
      or (item->>'run_id')::uuid is distinct from p_replace_run_id) then raise exception 'finding replacement scope mismatch'; end if;
  return query select * from public.save_findings_unchecked(p_findings,p_replace_analysis_id,p_replace_run_id);
end;
$$;

create function public.save_actions(p_actions jsonb, p_replace_analysis_id uuid default null, p_replace_run_id uuid default null)
returns table(action_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  if (p_replace_analysis_id is null) <> (p_replace_run_id is null) then raise exception 'replacement scope must be complete'; end if;
  if p_replace_run_id is not null and not exists (select 1 from public.analysis_runs r
    where r.id=p_replace_run_id and r.analysis_id=p_replace_analysis_id) then raise exception 'replacement run belongs to another analysis'; end if;
  if p_replace_run_id is not null and exists (select 1 from jsonb_array_elements(p_actions) item
    where (item->>'analysis_id')::uuid is distinct from p_replace_analysis_id
      or (item->>'run_id')::uuid is distinct from p_replace_run_id) then raise exception 'action replacement scope mismatch'; end if;
  return query select * from public.save_actions_unchecked(p_actions,p_replace_analysis_id,p_replace_run_id);
end;
$$;
revoke execute on function public.save_findings_unchecked(jsonb,uuid,uuid), public.save_actions_unchecked(jsonb,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.save_findings(jsonb,uuid,uuid), public.save_actions(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_findings(jsonb,uuid,uuid), public.save_actions(jsonb,uuid,uuid) to service_role;

create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs language plpgsql security definer set search_path = '' as $$
begin
  if worker_id is null or length(btrim(worker_id))=0 then raise exception 'worker_id must not be empty'; end if;
  if lease_seconds is null or lease_seconds<1 or lease_seconds>3600 then raise exception 'lease_seconds must be between 1 and 3600'; end if;
  return query with candidate as (
    select job.id from public.analysis_jobs job
    join public.analysis_runs run on run.id=job.run_id and run.analysis_id=job.analysis_id
    where job.available_at<=clock_timestamp() and (job.status='queued' or (job.status='leased' and job.lease_expires_at<=clock_timestamp()))
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
revoke execute on function public.lease_analysis_job(text,int) from public,anon,authenticated;
grant execute on function public.lease_analysis_job(text,int) to service_role;
