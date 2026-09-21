-- On a clean migration history 202609200003 does not change schema or data:
-- 202609200002 already contains the repaired body. This executable rollback
-- preserves all rows and restores the prior migration's access contract.
do $$
begin
  if to_regprocedure('public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])') is null then
    raise exception 'accept_analysis_submission_group is missing';
  end if;
end;
$$;

revoke execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  to service_role;

comment on function public.accept_analysis_submission_group(uuid, uuid, jsonb, text[])
  is 'Atomically composes cumulative supplement runs, supersedes obsolete work, and queues missing prerequisites.';
