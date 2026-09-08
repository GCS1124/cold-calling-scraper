-- Append-only integration request telemetry without lead payloads or raw credentials.
create table if not exists public.integration_audit_events (
  event_id bigint generated always as identity primary key,
  request_id text not null,
  owner_id text,
  api_key_id text,
  method text not null,
  path text not null,
  operation text not null,
  outcome text not null,
  status_code integer,
  error_code text,
  created_at timestamptz not null default now(),
  constraint integration_audit_outcome_check
    check (outcome in ('completed', 'failed', 'rejected')),
  constraint integration_audit_status_check
    check (status_code is null or (status_code >= 100 and status_code <= 599))
);

create index if not exists integration_audit_created_idx
  on public.integration_audit_events (created_at);

create index if not exists integration_audit_owner_created_idx
  on public.integration_audit_events (owner_id, created_at desc);

create index if not exists integration_audit_key_created_idx
  on public.integration_audit_events (api_key_id, created_at desc);
