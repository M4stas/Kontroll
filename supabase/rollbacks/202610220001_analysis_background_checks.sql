-- Stop workers before rollback. Saved lookup state is removed by this rollback.
drop trigger analysis_inputs_enqueue_background_check on public.analysis_inputs;
drop function public.enqueue_analysis_background_check();
drop function public.defer_analysis_job(uuid,text,timestamptz);
-- Remove only the additive lease branches; retain later unrelated function changes.
do $patch$
declare fn record; definition text;
begin
 for fn in select oid from pg_proc where pronamespace='public'::regnamespace
   and proname like 'lease_analysis_job%' loop
  definition:=pg_get_functiondef(fn.oid);
  if position($old$when 'background_check' then true$old$ in definition)>0 then
   definition:=replace(definition,$old$when 'background_check' then true
        $old$,'');
   definition:=replace(definition,$old$array['background_check','capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report']$old$,$new$array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report']$new$);
   definition:=replace(definition,$old$and (job.stage='background_check' or job.run_id=(select current_run_id$old$,$new$and (job.run_id=(select current_run_id$new$);
   execute definition;
  end if;
 end loop;
end;
$patch$;
do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])'::regprocedure) into definition;
 definition:=replace(definition,$old$and job.status in ('queued', 'leased')
      and job.stage <> 'background_check';$old$,$new$and job.status in ('queued', 'leased');$new$);
 definition:=replace(definition,$old$and obsolete_job.status in ('queued', 'leased')
    and obsolete_job.stage <> 'background_check'$old$,$new$and obsolete_job.status in ('queued', 'leased')$new$);
 execute definition;
end;
$patch$;
delete from public.analysis_jobs where stage='background_check';
drop table public.analysis_background_checks;
