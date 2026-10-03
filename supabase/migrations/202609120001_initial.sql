create type public.analysis_status as enum ('queued', 'running', 'partial', 'complete', 'failed');
create type public.stage_status as enum ('queued', 'running', 'complete', 'unavailable', 'failed');
create type public.verification_state as enum ('unverified', 'corroborated', 'official', 'contradicted', 'not_checked');
create type public.job_status as enum ('queued', 'leased', 'complete', 'failed');

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  access_token_hash text not null,
  locale text not null check (locale in ('et', 'en')),
  status public.analysis_status not null default 'queued',
  current_run_id uuid,
  verdict text check (verdict in ('worth_viewing', 'proceed_cautiously', 'likely_skip')),
  confidence text check (confidence in ('low', 'moderate', 'high')),
  owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  trigger text not null check (trigger in ('initial', 'supplement')),
  status public.analysis_status not null default 'queued',
  stage_states jsonb not null default '{}'::jsonb,
  failure jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.analyses
  add constraint analyses_current_run_fk
  foreign key (current_run_id) references public.analysis_runs(id);

create table public.analysis_inputs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  listing_url text not null,
  input_type text not null check (input_type in ('url', 'pasted_text', 'url_with_fallback')),
  pasted_text text,
  vin text,
  registration_plate text,
  created_at timestamptz not null default now()
);

create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  source_type text not null check (length(btrim(source_type)) > 0),
  source_url text,
  captured_at timestamptz not null default now(),
  content_hash text,
  storage_key text,
  extraction_status public.stage_status not null default 'queued',
  metadata jsonb not null default '{}'::jsonb
);

create table public.vehicle_facts (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  fact_key text not null check (length(btrim(fact_key)) > 0),
  fact_value text not null,
  normalized_value text,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete cascade,
  verification public.verification_state not null default 'unverified',
  match_confidence double precision not null check (match_confidence between 0 and 1),
  created_at timestamptz not null default now()
);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete cascade,
  source_class text not null check (
    source_class in ('official_registry', 'manufacturer', 'independent', 'forum', 'listing', 'seller', 'buyer')
  ),
  claim text not null check (length(btrim(claim)) > 0),
  applicability text not null check (length(btrim(applicability)) > 0),
  confidence double precision not null check (confidence between 0 and 1),
  verification public.verification_state not null default 'unverified',
  captured_at timestamptz not null default now(),
  constraint evidence_untrusted_sources_not_official check (
    verification <> 'official'
    or source_class not in ('listing', 'seller', 'buyer')
  )
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  category text not null,
  severity text not null check (severity in ('critical', 'important', 'context')),
  state text not null check (state in ('open', 'confirmed', 'cleared')),
  title text not null check (length(btrim(title)) > 0),
  explanation text not null,
  next_action text not null,
  origin text not null default 'deterministic' check (origin in ('deterministic', 'agent')),
  created_at timestamptz not null default now()
);

create table public.finding_evidence (
  finding_id uuid not null references public.findings(id) on delete cascade,
  evidence_id uuid not null references public.evidence(id) on delete cascade,
  relation text not null check (relation in ('supports', 'contradicts')),
  primary key (finding_id, evidence_id)
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  kind text not null check (
    kind in ('seller_question', 'photo_request', 'document_request', 'workshop_recommendation', 'inspection_task')
  ),
  title text not null,
  instructions text not null,
  status text not null default 'open' check (status in ('open', 'complete')),
  finding_id uuid references public.findings(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid references public.analysis_runs(id) on delete cascade,
  kind text not null check (kind in ('seller_answer', 'buyer_note', 'image', 'screenshot', 'document')),
  provided_by text not null check (provided_by in ('seller', 'buyer')),
  text_content text,
  storage_key text,
  mime_type text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint submissions_have_content check (text_content is not null or storage_key is not null)
);

create table public.vehicle_research_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  make text not null,
  model text not null,
  generation text,
  engine text,
  gearbox text,
  year_range text,
  mileage_band text,
  result jsonb not null,
  source_refs jsonb not null default '[]'::jsonb,
  schema_version integer not null check (schema_version > 0),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint vehicle_research_cache_expiry check (expires_at > fetched_at)
);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  run_id uuid not null references public.analysis_runs(id) on delete cascade,
  stage text not null check (length(btrim(stage)) > 0),
  status public.job_status not null default 'queued',
  attempts integer not null default 0 check (attempts >= 0),
  leased_by text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  last_error jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (analysis_id, run_id, stage)
);

create index analysis_runs_analysis_id_idx on public.analysis_runs (analysis_id);
create index analysis_inputs_analysis_id_idx on public.analysis_inputs (analysis_id);
create index source_snapshots_analysis_run_idx on public.source_snapshots (analysis_id, run_id);
create index vehicle_facts_analysis_run_idx on public.vehicle_facts (analysis_id, run_id);
create index evidence_analysis_run_idx on public.evidence (analysis_id, run_id);
create index findings_analysis_run_idx on public.findings (analysis_id, run_id);
create index actions_analysis_run_idx on public.actions (analysis_id, run_id);
create index submissions_analysis_id_idx on public.submissions (analysis_id);
create index analysis_jobs_lease_idx
  on public.analysis_jobs (available_at, created_at)
  where status in ('queued', 'leased');

alter table public.analyses enable row level security;
alter table public.analysis_runs enable row level security;
alter table public.analysis_inputs enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.vehicle_facts enable row level security;
alter table public.evidence enable row level security;
alter table public.findings enable row level security;
alter table public.finding_evidence enable row level security;
alter table public.actions enable row level security;
alter table public.submissions enable row level security;
alter table public.vehicle_research_cache enable row level security;
alter table public.analysis_jobs enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'analysis-uploads',
  'analysis-uploads',
  false,
  12582912,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.create_analysis(
  p_access_token_hash text,
  p_locale text,
  p_listing_url text,
  p_input_type text default 'url',
  p_pasted_text text default null,
  p_vin text default null,
  p_registration_plate text default null
)
returns table (public_id uuid, run_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_analysis_id uuid;
  v_public_id uuid;
  v_run_id uuid;
begin
  insert into public.analyses (access_token_hash, locale)
  values (p_access_token_hash, p_locale)
  returning id, analyses.public_id into v_analysis_id, v_public_id;

  insert into public.analysis_inputs (
    analysis_id,
    listing_url,
    input_type,
    pasted_text,
    vin,
    registration_plate
  )
  values (
    v_analysis_id,
    p_listing_url,
    p_input_type,
    p_pasted_text,
    p_vin,
    p_registration_plate
  );

  insert into public.analysis_runs (analysis_id, trigger)
  values (v_analysis_id, 'initial')
  returning id into v_run_id;

  update public.analyses
  set current_run_id = v_run_id
  where id = v_analysis_id;

  insert into public.analysis_jobs (
    analysis_id,
    run_id,
    stage,
    idempotency_key
  )
  values (
    v_analysis_id,
    v_run_id,
    'capture_listing',
    v_analysis_id::text || ':' || v_run_id::text || ':capture_listing'
  );

  return query select v_public_id, v_run_id;
end;
$$;

create or replace function public.lease_analysis_job(worker_id text, lease_seconds int)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if worker_id is null or length(btrim(worker_id)) = 0 then
    raise exception 'worker_id must not be empty';
  end if;

  if lease_seconds is null or lease_seconds < 1 or lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 1 and 3600';
  end if;

  return query
  with candidate as (
    select job.id
    from public.analysis_jobs as job
    where
      job.available_at <= clock_timestamp()
      and (
        job.status = 'queued'
        or (
          job.status = 'leased'
          and job.lease_expires_at <= clock_timestamp()
        )
      )
    order by job.available_at, job.created_at
    for update skip locked
    limit 1
  )
  update public.analysis_jobs as job
  set
    status = 'leased',
    attempts = job.attempts + 1,
    leased_by = worker_id,
    lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
    completed_at = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

revoke execute on function public.create_analysis(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_analysis(text, text, text, text, text, text, text)
  to service_role;

revoke execute on function public.lease_analysis_job(text, int)
  from public, anon, authenticated;
grant execute on function public.lease_analysis_job(text, int)
  to service_role;
