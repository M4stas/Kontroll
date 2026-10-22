-- Run after the migration in a transaction; all fixtures are synthetic.
do $$
declare created record; aid uuid; jid uuid; leased public.analysis_jobs; original_attempts int;
begin
 select * into created from public.create_analysis('fake-hash','en','https://www.auto24.ee/soidukid/123456');
 select id into aid from public.analyses where public_id=created.public_id;
 if exists(select 1 from public.analysis_jobs where analysis_id=aid and stage='background_check') then raise exception 'manual entry got a background job'; end if;
 update public.analysis_inputs set service_job_id='fake-job' where analysis_id=aid;
 update public.analysis_inputs set service_job_id='fake-job' where analysis_id=aid;
 if (select count(*) from public.analysis_background_checks where analysis_id=aid and status='not_requested')<>1 then raise exception 'expected one initial record'; end if;
 if (select count(*) from public.analysis_jobs where analysis_id=aid and stage='background_check')<>1 then raise exception 'expected one background job'; end if;
 update public.analysis_jobs set available_at=clock_timestamp()+interval '1 hour' where analysis_id=aid and stage<>'background_check';
 select * into leased from public.lease_analysis_job_scoped('fake-worker',60,aid);
 if leased.stage is distinct from 'background_check' then raise exception 'background stage could not lease independently'; end if;
 jid:=leased.id; original_attempts:=leased.attempts;
 begin
  perform public.defer_analysis_job(jid,'wrong-worker',clock_timestamp()+interval '3 seconds');
  raise exception 'wrong worker deferred';
 exception when others then
  if sqlerrm='wrong worker deferred' then raise; end if;
 end;
 perform public.defer_analysis_job(jid,'fake-worker',clock_timestamp()+interval '3 seconds');
 select * into leased from public.analysis_jobs where id=jid;
 if leased.status<>'queued' or leased.attempts<>original_attempts-1 or leased.leased_by is not null or leased.lease_expires_at is not null then raise exception 'deferral did not restore attempts and clear lease'; end if;
 if exists(select 1 from public.lease_analysis_job_scoped('fake-worker',60,aid)) then raise exception 'deferred job leased too early'; end if;
 update public.analysis_jobs set available_at=clock_timestamp()-interval '1 second' where id=jid;
 select * into leased from public.lease_analysis_job_scoped('fake-worker',60,aid);
 if leased.id is distinct from jid then raise exception 'deferred job did not become available'; end if;
 update public.analysis_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=jid;
 begin
  perform public.defer_analysis_job(jid,'fake-worker',clock_timestamp());
  raise exception 'expired lease deferred';
 exception when others then
  if sqlerrm='expired lease deferred' then raise; end if;
 end;
 if has_function_privilege('anon','public.defer_analysis_job(uuid,text,timestamptz)','EXECUTE') or has_function_privilege('authenticated','public.defer_analysis_job(uuid,text,timestamptz)','EXECUTE') then raise exception 'private deferral RPC exposed'; end if;
 if has_table_privilege('anon','public.analysis_background_checks','SELECT') or has_table_privilege('authenticated','public.analysis_background_checks','SELECT') then raise exception 'private table exposed'; end if;
 -- The public creation RPC gains the same atomic initialization.
 select * into created from public.create_analysis_from_capture('fake-hash','en','https://www.auto24.ee/soidukid/123456','url',null,null,null,'fake-capture-job','{}'::jsonb);
 select id into aid from public.analyses where public_id=created.public_id;
 if (select count(*) from public.analysis_jobs where analysis_id=aid and stage='background_check')<>1 then raise exception 'capture RPC did not create background job'; end if;
end;
$$;

-- Analysis-scoped work survives both ordinary supplements and PDF review reuse.
do $$
declare created record; aid uuid; initial_run uuid; jid uuid; leased public.analysis_jobs;
begin
 select * into created from public.create_analysis_from_capture('fake-hash','en','https://www.auto24.ee/soidukid/123456','url',null,null,null,'fake-supplement-job','{}'::jsonb);
 initial_run:=created.run_id;
 select id into aid from public.analyses where public_id=created.public_id;
 select id into jid from public.analysis_jobs where analysis_id=aid and stage='background_check';
 update public.analysis_runs set stage_states='{"capture_listing":{"status":"complete"},"normalize_identity":{"status":"complete"},"baseline_checks":{"status":"complete"},"research":{"status":"complete"}}'::jsonb where id=initial_run;
 perform public.accept_analysis_submission_group(aid,gen_random_uuid(),'[{"kind":"seller_answer","provided_by":"seller","text_content":"Synthetic seller reply"}]'::jsonb,array['enrich','assemble_report']);
 if (select status from public.analysis_jobs where id=jid)<>'queued' then raise exception 'seller reply cancelled background check'; end if;
 if (select count(*) from public.analysis_jobs where analysis_id=aid and stage='background_check')<>1 then raise exception 'seller reply duplicated background check'; end if;
 update public.analysis_jobs set available_at=clock_timestamp()+interval '1 hour' where analysis_id=aid and stage<>'background_check';
 select * into leased from public.lease_analysis_job_scoped('fake-worker',60,aid);
 if leased.id is distinct from jid then raise exception 'superseded initial background check could not lease'; end if;
 perform public.accept_analysis_submission_group(aid,gen_random_uuid(),jsonb_build_array(jsonb_build_object('kind','document','provided_by','buyer','storage_key',aid::text||'/fake.pdf','mime_type','application/pdf')),array['enrich','assemble_report']);
 if (select status from public.analysis_jobs where id=jid)<>'leased' then raise exception 'PDF cancelled leased background check'; end if;
 if (select count(*) from public.analysis_jobs where analysis_id=aid and stage='background_check')<>1 then raise exception 'PDF duplicated background check'; end if;
 perform public.defer_analysis_job(jid,'fake-worker',clock_timestamp()-interval '1 second');
 update public.analysis_jobs set available_at=clock_timestamp()+interval '1 hour' where analysis_id=aid and stage<>'background_check';
 select * into leased from public.lease_analysis_job_scoped('fake-worker',60,aid);
 if leased.id is distinct from jid or leased.run_id<>initial_run then raise exception 'background check lost its original run'; end if;
end;
$$;
