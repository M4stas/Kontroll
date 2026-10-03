-- Local installations that already applied an earlier 001 draft receive the
-- same corrected trigger body as clean installations. No rows are rewritten.
create or replace function public.assert_analysis_artifact_ownership()
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
