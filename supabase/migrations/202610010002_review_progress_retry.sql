-- Recovery preserves pinned settings and successful pass records; only job state changes.
create or replace function public.save_review_progress(p_analysis_id uuid,p_run_id uuid,p_job_id uuid,p_worker_id text,p_result jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.review_assert_live_lease(p_analysis_id,p_run_id,p_job_id,p_worker_id);
 if exists(select 1 from public.review_executions where analysis_id=p_analysis_id and run_id=p_run_id and pass='final' and result_hash is not null) then return; end if;
 if jsonb_typeof(p_result) is distinct from 'object' or not public.review_audit_json_safe(p_result)
   or octet_length(p_result::text)>200000 or p_result->>'status' not in ('complete','unavailable')
   or jsonb_typeof(p_result#>'{output,review}') is distinct from 'object'
   or p_result#>'{output,findings}' is distinct from '[]'::jsonb or p_result#>'{output,actions}' is distinct from '[]'::jsonb then
   raise exception 'invalid public review progress';
 end if;
 update public.analysis_runs set stage_states=jsonb_set(coalesce(stage_states,'{}'::jsonb),'{enrich}',p_result),status='running' where id=p_run_id and analysis_id=p_analysis_id;
 update public.analyses set status='partial',updated_at=clock_timestamp() where id=p_analysis_id and current_run_id=p_run_id;
end;$$;

create or replace function public.retry_current_review(p_analysis_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_job public.analysis_jobs%rowtype;
begin
 select current_run_id into v_run from public.analyses where id=p_analysis_id for update;
 if v_run is null then return false; end if;
 if exists(select 1 from public.review_executions where analysis_id=p_analysis_id and run_id=v_run and pass='final' and result_hash is not null) then return false; end if;
 select * into v_job from public.analysis_jobs where analysis_id=p_analysis_id and run_id=v_run and stage='enrich' for update;
 if not found then return false; end if;
 if v_job.status in ('queued','leased') then return true; end if;
 update public.analysis_jobs set status='queued',attempts=0,leased_by=null,lease_expires_at=null,available_at=clock_timestamp(),completed_at=null,last_error=null where id=v_job.id;
 update public.analysis_jobs set status='complete',leased_by=null,lease_expires_at=null,completed_at=clock_timestamp() where analysis_id=p_analysis_id and run_id=v_run and stage='assemble_report' and status<>'leased';
 update public.analysis_runs set stage_states=stage_states-'assemble_report',status='running',failure=null where id=v_run and analysis_id=p_analysis_id;
 update public.analyses set status='partial',updated_at=clock_timestamp() where id=p_analysis_id and current_run_id=v_run;
 return true;
end;$$;
revoke all on function public.save_review_progress(uuid,uuid,uuid,text,jsonb),public.retry_current_review(uuid) from public,anon,authenticated;
grant execute on function public.save_review_progress(uuid,uuid,uuid,text,jsonb),public.retry_current_review(uuid) to service_role;
