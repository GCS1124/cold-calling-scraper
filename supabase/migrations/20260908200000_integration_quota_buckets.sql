-- Optional per-credential daily integration request quotas.
-- A zero quota configuration disables the guard; raw credentials are never stored.
create table if not exists public.integration_quota_buckets (
  bucket_key text not null,
  window_start bigint not null,
  request_count integer not null,
  updated_at timestamptz not null default now(),
  primary key (bucket_key, window_start)
);

create index if not exists integration_quota_updated_idx
  on public.integration_quota_buckets (updated_at);
