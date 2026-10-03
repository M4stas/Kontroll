-- Preserve the unfinished prerequisite when a developer rereviews a partial report.
-- Developer-only: apply new runtime settings to a fresh child run at the existing private URL.
create or replace function public.developer_rereview_analysis(p_analysis_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_parent uuid;v_run uuid;v_states jsonb;v_research_pending boolean;v_photos_unavailable boolean;v_stages text[];
begin
 select current_run_id into v_parent from public.analyses where id=p_analysis_id for update;
 if v_parent is null then raise exception 'analysis not found'; end if;
 select stage_states into v_states from public.analysis_runs where id=v_parent and analysis_id=p_analysis_id for update;
 if not v_states @> '{"baseline_checks":{"status":"complete"}}'::jsonb then raise exception 'baseline must complete before developer rereview'; end if;
 -- Retry transient photo preparation from stored capture inputs without changing the parent audit.
 v_photos_unavailable := exists(select 1 from jsonb_array_elements(coalesce(v_states#>'{capture_listing,output,snapshot,photoPreparation,images}','[]'::jsonb)) image where image->>'status'='unavailable');
 v_research_pending := coalesce(v_states->'research'->>'status','queued') not in ('complete','unavailable');
 v_stages := array['enrich'];
 if v_photos_unavailable then
  v_states := v_states-array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'];
  v_stages := array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report'];
 elsif v_research_pending then
  v_states := v_states-'research';
  v_stages := v_stages||array['research'];
 end if;
 insert into public.analysis_runs(analysis_id,trigger,parent_run_id,stage_states)
 values(p_analysis_id,'supplement',v_parent,v_states-array['enrich','assemble_report']) returning id into v_run;
 update public.analysis_jobs set status='failed',leased_by=null,lease_expires_at=null,completed_at=clock_timestamp(),last_error='{"code":"superseded"}'::jsonb where analysis_id=p_analysis_id and run_id=v_parent and status in ('queued','leased');
 update public.analyses set current_run_id=v_run,status='partial',updated_at=clock_timestamp() where id=p_analysis_id;
 insert into public.analysis_jobs(analysis_id,run_id,stage,idempotency_key)
 select p_analysis_id,v_run,stage,p_analysis_id::text||':'||v_run::text||':'||stage from unnest(v_stages) stage;
 return v_run;
end;$$;
revoke all on function public.developer_rereview_analysis(uuid) from public,anon,authenticated;
grant execute on function public.developer_rereview_analysis(uuid) to service_role;
