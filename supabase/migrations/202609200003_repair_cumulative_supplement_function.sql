do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])'::regprocedure
  ) into v_definition;

  v_definition := replace(v_definition, 'v_queued_stages || ''baseline_checks''', 'v_queued_stages || array[''baseline_checks'']');
  v_definition := replace(v_definition, 'v_queued_stages || ''normalize_identity''', 'v_queued_stages || array[''normalize_identity'']');
  v_definition := replace(v_definition, 'v_queued_stages || ''capture_listing''', 'v_queued_stages || array[''capture_listing'']');
  v_definition := replace(v_definition, 'update public.analysis_jobs' || chr(10) || '  set', 'update public.analysis_jobs as obsolete_job' || chr(10) || '  set');
  v_definition := replace(v_definition, 'where analysis_id = p_analysis_id' || chr(10) || '    and run_id = v_previous_run_id' || chr(10) || '    and status in', 'where obsolete_job.analysis_id = p_analysis_id' || chr(10) || '    and obsolete_job.run_id = v_previous_run_id' || chr(10) || '    and obsolete_job.status in');

  execute v_definition;
end;
$$;

revoke execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  to service_role;

comment on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  is 'Atomically composes cumulative supplement runs, supersedes obsolete work, and queues missing prerequisites.';
