-- Developer-only: apply new runtime settings to a fresh child run at the existing private URL.
create or replace function public.developer_rereview_analysis(p_analysis_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_parent uuid;v_run uuid;v_states jsonb;
begin
 select current_run_id into v_parent from public.analyses where id=p_analysis_id for update;
 if v_parent is null then raise exception 'analysis not found'; end if;
 select stage_states into v_states from public.analysis_runs where id=v_parent and analysis_id=p_analysis_id for update;
 if not v_states @> '{"baseline_checks":{"status":"complete"}}'::jsonb then raise exception 'baseline must complete before developer rereview'; end if;
 insert into public.analysis_runs(analysis_id,trigger,parent_run_id,stage_states)
 values(p_analysis_id,'supplement',v_parent,v_states-array['enrich','assemble_report']) returning id into v_run;
 update public.analysis_jobs set status='failed',leased_by=null,lease_expires_at=null,completed_at=clock_timestamp(),last_error='{"code":"superseded"}'::jsonb where analysis_id=p_analysis_id and run_id=v_parent and status in ('queued','leased');
 update public.analyses set current_run_id=v_run,status='partial',updated_at=clock_timestamp() where id=p_analysis_id;
 insert into public.analysis_jobs(analysis_id,run_id,stage,idempotency_key)
 values(p_analysis_id,v_run,'enrich',p_analysis_id::text||':'||v_run::text||':enrich');
 return v_run;
end;$$;
revoke all on function public.developer_rereview_analysis(uuid) from public,anon,authenticated;
grant execute on function public.developer_rereview_analysis(uuid) to service_role;
