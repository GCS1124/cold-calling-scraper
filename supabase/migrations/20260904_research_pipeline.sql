create extension if not exists pgcrypto;

-- The API keeps the current lead_finder_jobs JSON contract for compatibility.
-- These tables hold the durable job contract, research evidence, and worker
-- state. The JSON payload remains compatible with the current API while the
-- normalized tables are populated incrementally.
create table if not exists public.lead_finder_jobs (
  search_id text primary key,
  payload jsonb not null,
  expires_at bigint not null,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists lead_finder_jobs_expires_at_idx
  on public.lead_finder_jobs (expires_at);

create index if not exists lead_finder_jobs_updated_at_idx
  on public.lead_finder_jobs (updated_at);

create table if not exists public.lead_finder_research_queue (
  search_id text primary key,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'complete', 'dead')),
  attempts integer not null default 0,
  available_at bigint not null,
  lease_until bigint,
  lease_token text,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists lead_finder_research_queue_ready_idx
  on public.lead_finder_research_queue (status, available_at);

create table if not exists public.research_organizations (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  name text not null,
  category text,
  city text,
  state_code text,
  website text,
  listing_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_organizations_location_idx
  on public.research_organizations (state_code, city);

create table if not exists public.research_people (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  full_name text not null,
  headline text,
  linkedin_url text,
  employment_status text not null default 'unverified'
    check (employment_status in ('current', 'probable', 'uncertain', 'conflicting', 'former', 'unverified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.research_organization_people (
  organization_id uuid not null references public.research_organizations (id) on delete cascade,
  person_id uuid not null references public.research_people (id) on delete cascade,
  role_title text,
  relationship_status text not null default 'unverified'
    check (relationship_status in ('current', 'probable', 'uncertain', 'conflicting', 'former', 'unverified')),
  source_document_id uuid,
  observed_at timestamptz not null default now(),
  primary key (organization_id, person_id)
);

create index if not exists research_organization_people_person_idx
  on public.research_organization_people (person_id, relationship_status);

create table if not exists public.research_job_steps (
  id uuid primary key default gen_random_uuid(),
  search_id text not null,
  step_key text not null,
  status text not null check (status in ('queued', 'running', 'complete', 'failed', 'cancelled')),
  attempt integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  unique (search_id, step_key, attempt)
);

create index if not exists research_job_steps_search_idx
  on public.research_job_steps (search_id, started_at);

create table if not exists public.research_source_documents (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  source_url text not null,
  source_name text not null,
  source_family text not null,
  fetched_at timestamptz not null default now(),
  observed_at timestamptz,
  content_hash text,
  authority_tier text,
  metadata jsonb not null default '{}'::jsonb,
  unique (search_id, source_url)
);

create table if not exists public.research_claims (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  entity_type text not null check (entity_type in ('organization', 'person', 'contact', 'opportunity')),
  entity_key text not null,
  claim_type text not null,
  claim_value jsonb not null,
  status text not null check (status in ('confirmed', 'corroborated', 'inferred', 'stale', 'conflicting', 'rejected', 'unknown')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists research_claims_entity_idx
  on public.research_claims (entity_type, entity_key, last_seen_at desc);

create table if not exists public.research_claim_evidence (
  claim_id uuid not null references public.research_claims (id) on delete cascade,
  source_document_id uuid not null references public.research_source_documents (id) on delete cascade,
  excerpt text,
  supports boolean not null default true,
  primary key (claim_id, source_document_id)
);

create table if not exists public.research_contact_points (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  entity_key text not null,
  kind text not null check (kind in ('mobile', 'phone', 'email', 'website', 'social')),
  value text not null,
  normalized_value text,
  status text not null check (status in ('public', 'validated', 'invalid', 'unknown', 'suppressed')),
  source_document_id uuid references public.research_source_documents (id) on delete set null,
  observed_at timestamptz not null default now()
);

create index if not exists research_contact_points_entity_idx
  on public.research_contact_points (entity_key, kind, status);

create table if not exists public.research_verification_events (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  entity_key text not null,
  field_name text not null,
  result text not null,
  source_document_id uuid references public.research_source_documents (id) on delete set null,
  checked_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.research_opportunity_signals (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  entity_key text not null,
  signal_type text not null,
  label text not null,
  source_document_id uuid references public.research_source_documents (id) on delete set null,
  observed_at timestamptz not null default now(),
  confidence integer not null default 0 check (confidence between 0 and 100)
);

create table if not exists public.research_lead_snapshots (
  id uuid primary key default gen_random_uuid(),
  search_id text not null,
  entity_key text not null,
  snapshot jsonb not null,
  captured_at timestamptz not null default now(),
  unique (search_id, entity_key)
);

create table if not exists public.research_suppression_entries (
  id uuid primary key default gen_random_uuid(),
  entity_key text,
  normalized_value text,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists research_suppression_lookup_idx
  on public.research_suppression_entries (entity_key, normalized_value);

create table if not exists public.research_feedback_events (
  id uuid primary key default gen_random_uuid(),
  search_id text,
  entity_key text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
