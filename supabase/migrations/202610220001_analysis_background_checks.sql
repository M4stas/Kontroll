-- Website-owned lookup state, deliberately separate from submissions and review runs.
create table public.analysis_background_checks (
 analysis_id uuid primary key references public.analyses(id) on delete cascade,
 service_job_id text not null check (service_job_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 status text not null default 'not_requested' check (status in ('not_requested','not_started','pending','fetched','not_found','skipped','unavailable')),
 reason text check (reason in ('no_identity','captcha_failed','blocked','timeout','pdf_rejected','site_changed','browser_crash')),
 searched_by text check (searched_by in ('reg_number','vin')),
 requested_at timestamptz,
 fetched_at timestamptz,
 storage_key text,
 size_bytes bigint check (size_bytes > 0 and size_bytes <= 12582912),
 sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz not null default clock_timestamp(),
 check ((status='fetched' and fetched_at is not null and storage_key is not null and size_bytes is not null and sha256 is not null)
   or (status<>'fetched' and fetched_at is null and storage_key is null and size_bytes is null and sha256 is null))
);
alter table public.analysis_background_checks enable row level security;
revoke all on public.analysis_background_checks from public,anon,authenticated;
grant all on public.analysis_background_checks to service_role;

create function public.enqueue_analysis_background_check()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_run_id uuid;
begin
 if new.service_job_id is null then return new; end if;
 select run.id into v_run_id from public.analyses analysis
 join public.analysis_runs run on run.id=analysis.current_run_id and run.analysis_id=analysis.id
 where analysis.id=new.analysis_id and run.trigger='initial'
 for update of analysis;
 if v_run_id is null then return new; end if;
 insert into public.analysis_background_checks(analysis_id,service_job_id)
 values(new.analysis_id,new.service_job_id) on conflict (analysis_id) do nothing;
 -- Only the first successful record insertion starts work, including across input rows.
 if found then
  insert into public.analysis_jobs(analysis_id,run_id,stage,idempotency_key)
  values(new.analysis_id,v_run_id,'background_check',new.analysis_id::text||':'||v_run_id::text||':background_check')
  on conflict do nothing;
 end if;
 return new;
end;
$$;
revoke execute on function public.enqueue_analysis_background_check() from public,anon,authenticated;
create trigger analysis_inputs_enqueue_background_check
 after insert or update of service_job_id on public.analysis_inputs
 for each row execute function public.enqueue_analysis_background_check();

-- Preserve the current lease implementation, including its PDF reuse guards.
-- Global leasing delegates to scoped leasing; also patch independently deployed variants.
do $patch$
declare fn record; definition text; patched text;
begin
 for fn in select oid from pg_proc where pronamespace='public'::regnamespace
   and proname like 'lease_analysis_job%' loop
  definition:=pg_get_functiondef(fn.oid);
  if position($old$when 'capture_listing' then true$old$ in definition)>0 then
   patched:=replace(definition,$old$when 'capture_listing' then true$old$,$new$when 'background_check' then true
        when 'capture_listing' then true$new$);
   patched:=replace(patched,$old$array['capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report']$old$,$new$array['background_check','capture_listing','normalize_identity','baseline_checks','research','enrich','assemble_report']$new$);
   if position($old$and (job.run_id=(select current_run_id$old$ in patched)=0 then
    raise exception 'Background check current-run prerequisite missing: %',fn.oid::regprocedure;
   end if;
   patched:=replace(patched,$old$and (job.run_id=(select current_run_id$old$,$new$and (job.stage='background_check' or job.run_id=(select current_run_id$new$);
   execute patched;
  elsif position('case job.stage' in definition)>0 then
   raise exception 'Background check migration prerequisite missing: %',fn.oid::regprocedure;
  end if;
 end loop;
end;
$patch$;

-- A lookup belongs to the analysis: supplement runs neither copy nor cancel it.
do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])'::regprocedure) into definition;
 if position($old$and job.status in ('queued', 'leased');$old$ in definition)=0
   or position($old$and obsolete_job.status in ('queued', 'leased')$old$ in definition)=0 then
  raise exception 'Background check supplement prerequisite missing';
 end if;
 definition:=replace(definition,$old$and job.status in ('queued', 'leased');$old$,$new$and job.status in ('queued', 'leased')
      and job.stage <> 'background_check';$new$);
 definition:=replace(definition,$old$and obsolete_job.status in ('queued', 'leased')$old$,$new$and obsolete_job.status in ('queued', 'leased')
    and obsolete_job.stage <> 'background_check'$new$);
 execute definition;
end;
$patch$;

create function public.defer_analysis_job(p_job_id uuid,p_worker_id text,p_available_at timestamptz)
returns setof public.analysis_jobs language plpgsql security definer set search_path='' as $$
declare v_job public.analysis_jobs;
begin
 if p_available_at is null or not isfinite(p_available_at) then raise exception 'available_at must be finite'; end if;
 update public.analysis_jobs job set status='queued',available_at=p_available_at,
   attempts=greatest(0,job.attempts-1),completed_at=null,leased_by=null,lease_expires_at=null,last_error=null
 where job.id=p_job_id and job.status='leased' and job.leased_by=p_worker_id and job.lease_expires_at>clock_timestamp()
 returning job.* into v_job;
 if not found then raise exception 'analysis job active lease not found for worker'; end if;
 return next v_job;
end;
$$;
revoke execute on function public.defer_analysis_job(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.defer_analysis_job(uuid,text,timestamptz) to service_role;
