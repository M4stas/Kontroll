-- Persist the existing scraper result atomically with report creation.
alter table public.analysis_inputs add column service_job_id text;
alter table public.analysis_inputs add column capture_snapshot jsonb;
create or replace function public.create_analysis_from_capture(
 p_access_token_hash text, p_locale text, p_listing_url text,
 p_input_type text default 'url', p_pasted_text text default null,
 p_vin text default null, p_registration_plate text default null,
 p_service_job_id text default null, p_capture_snapshot jsonb default null
) returns table(public_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_created record;
begin
 if p_service_job_id is null or p_service_job_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_capture_snapshot is null then
  raise exception 'A completed or failed service capture is required';
 end if;
 select * into v_created from public.create_analysis(p_access_token_hash,p_locale,p_listing_url,p_input_type,p_pasted_text,p_vin,p_registration_plate);
 update public.analysis_inputs i set service_job_id = p_service_job_id, capture_snapshot = p_capture_snapshot
 from public.analyses a where i.analysis_id = a.id and a.public_id = v_created.public_id;
 return query select v_created.public_id::uuid, v_created.run_id::uuid;
end;
$$;
revoke execute on function public.create_analysis_from_capture(text,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_analysis_from_capture(text,text,text,text,text,text,text,text,jsonb) to service_role;
