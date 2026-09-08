-- Per-credential integration traffic protection.
-- The bucket key is a server-side SHA-256 digest; raw credentials are never stored.
create table if not exists public.integration_rate_limit_buckets (
  bucket_key text not null,
  window_start bigint not null,
  request_count integer not null,
  updated_at timestamptz not null default now(),
  primary key (bucket_key, window_start)
);

create index if not exists integration_rate_limit_updated_idx
  on public.integration_rate_limit_buckets (updated_at);
