-- Private, bounded telemetry; immutable review inputs and results are untouched.
create table public.diagnostic_photo_spans (
 id uuid primary key,
 analysis_id uuid not null references public.analyses(id) on delete cascade,
 run_id uuid not null references public.analysis_runs(id) on delete cascade,
 job_id uuid not null references public.analysis_jobs(id) on delete cascade,
 worker_id text not null check(length(worker_id) between 1 and 128),
 job_lease_attempt integer not null check(job_lease_attempt > 0),
 evidence_id uuid not null,
 parent_id uuid references public.diagnostic_photo_spans(id) on delete cascade,
 phase text not null check(phase in ('capture_prepare','download','validation','normalization','upload','capability_verification','reviewer_prepare','retrieval','verification','png_preparation')),
 state text not null check(state in ('running','complete','failed','incomplete')),
 started_at timestamptz not null,
 completed_at timestamptz,
 duration_ms double precision check(duration_ms >= 0 and duration_ms < 'Infinity'::double precision),
 omitted_count integer not null default 0 check(omitted_count between 0 and 5000),
 error_code text check(error_code in ('phase_failed','collection_incomplete')),
 check(completed_at is null or completed_at >= started_at),
 check((state = 'running' and completed_at is null and duration_ms is null) or state <> 'running')
);
create index diagnostic_photo_spans_run_idx on public.diagnostic_photo_spans(analysis_id,run_id,started_at desc,id desc);
create index diagnostic_photo_spans_attempt_idx on public.diagnostic_photo_spans(job_id,job_lease_attempt);
alter table public.diagnostic_photo_spans enable row level security;
revoke all on public.diagnostic_photo_spans from public,anon,authenticated,service_role;
grant select on public.diagnostic_photo_spans to service_role;

create or replace function public.record_photo_timing_spans(
 p_analysis_id uuid,p_run_id uuid,p_job_id uuid,p_worker_id text,p_job_lease_attempt integer,p_spans jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare
 v_job public.analysis_jobs%rowtype;
 v_row jsonb;
 v_existing public.diagnostic_photo_spans%rowtype;
 v_id uuid;
 v_evidence uuid;
 v_parent uuid;
 v_count integer;
 v_owned boolean;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service role required'; end if;
 -- Lock in the same analysis/run/job order as durable review writes.
 perform 1 from public.analyses where id=p_analysis_id and current_run_id=p_run_id for update;
 if not found then raise exception 'timing run is no longer current'; end if;
 perform 1 from public.analysis_runs where id=p_run_id and analysis_id=p_analysis_id for update;
 if not found then raise exception 'timing run ownership mismatch'; end if;
 select * into v_job from public.analysis_jobs where id=p_job_id and analysis_id=p_analysis_id and run_id=p_run_id for update;
 if not found or v_job.stage not in ('capture_listing','enrich') or v_job.status <> 'leased' or v_job.leased_by is distinct from p_worker_id
   or v_job.attempts is distinct from p_job_lease_attempt or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
  raise exception 'timing lease is not live or owned';
 end if;
 if jsonb_typeof(p_spans) <> 'array' or jsonb_array_length(p_spans) not between 1 and 32 or octet_length(p_spans::text)>65536 then raise exception 'invalid timing batch'; end if;
 select count(*) into v_count from public.diagnostic_photo_spans where job_id=p_job_id and job_lease_attempt=p_job_lease_attempt;
 for v_row in select value from jsonb_array_elements(p_spans) loop
  if jsonb_typeof(v_row)<>'object' or exists(select 1 from jsonb_object_keys(v_row) key where key not in ('id','evidenceId','parentId','phase','state','startedAt','completedAt','durationMs','errorCode','jobAttempt','omittedCount')) then raise exception 'invalid timing fields'; end if;
  v_id := (v_row->>'id')::uuid; v_evidence := (v_row->>'evidenceId')::uuid; v_parent := (v_row->>'parentId')::uuid;
  if v_job.stage='capture_listing' then
   select exists(
    select 1 from public.analysis_inputs i cross join lateral jsonb_array_elements_text(coalesce(i.capture_snapshot->'imageUrls','[]'::jsonb)) with ordinality url(value,position)
    where i.analysis_id=p_analysis_id and url.position <= 24
      and public.review_citation_uuid(p_analysis_id::text||':'||p_run_id::text||':capture-image:'||public.review_citation_uuid(p_analysis_id::text||':listing-photo:'||(url.position-1)::text||':'||url.value)::text)=v_evidence
   ) into v_owned;
   if v_row->>'phase' not in ('capture_prepare','download','validation','normalization','upload') then raise exception 'invalid capture phase'; end if;
  else
   select exists(select 1 from public.review_run_snapshots s cross join lateral jsonb_array_elements(s.snapshot->'imageManifest'->'images') image
     where s.analysis_id=p_analysis_id and s.run_id=p_run_id and image->>'evidenceId'=v_evidence::text) into v_owned;
   if v_row->>'phase' not in ('capability_verification','reviewer_prepare','retrieval','verification','png_preparation') then raise exception 'invalid review phase'; end if;
  end if;
  if not v_owned then raise exception 'timing evidence ownership mismatch'; end if;
  if v_parent is not null and (v_parent=v_id or not exists(select 1 from public.diagnostic_photo_spans where id=v_parent and analysis_id=p_analysis_id and run_id=p_run_id and job_id=p_job_id and worker_id=p_worker_id and job_lease_attempt=p_job_lease_attempt and evidence_id=v_evidence)) then raise exception 'timing parent ownership mismatch'; end if;
  select * into v_existing from public.diagnostic_photo_spans where id=v_id;
  if found then
   if v_existing.analysis_id<>p_analysis_id or v_existing.run_id<>p_run_id or v_existing.job_id<>p_job_id or v_existing.worker_id<>p_worker_id or v_existing.job_lease_attempt<>p_job_lease_attempt or v_existing.evidence_id<>v_evidence or v_existing.parent_id is distinct from v_parent or v_existing.phase<>v_row->>'phase' or v_existing.started_at<>(v_row->>'startedAt')::timestamptz then raise exception 'timing identity immutable'; end if;
   update public.diagnostic_photo_spans set omitted_count=greatest(omitted_count,coalesce((v_row->>'omittedCount')::integer,0)) where id=v_id;
   if v_existing.state <> 'running' then continue; end if;
   update public.diagnostic_photo_spans set state=v_row->>'state',completed_at=(v_row->>'completedAt')::timestamptz,duration_ms=(v_row->>'durationMs')::double precision,error_code=v_row->>'errorCode' where id=v_id;
  else
   if v_count>=500 then raise exception 'timing attempt budget exceeded'; end if;
   insert into public.diagnostic_photo_spans(id,analysis_id,run_id,job_id,worker_id,job_lease_attempt,evidence_id,parent_id,phase,state,started_at,completed_at,duration_ms,error_code,omitted_count)
    values(v_id,p_analysis_id,p_run_id,p_job_id,p_worker_id,p_job_lease_attempt,v_evidence,v_parent,v_row->>'phase',v_row->>'state',(v_row->>'startedAt')::timestamptz,(v_row->>'completedAt')::timestamptz,(v_row->>'durationMs')::double precision,v_row->>'errorCode',coalesce((v_row->>'omittedCount')::integer,0));
   v_count:=v_count+1;
  end if;
 end loop;
end;
$$;
revoke all on function public.record_photo_timing_spans(uuid,uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_photo_timing_spans(uuid,uuid,uuid,text,integer,jsonb) to service_role;
