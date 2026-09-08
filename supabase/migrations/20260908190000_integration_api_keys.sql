-- Hash-only integration credentials with explicit rotation and revocation state.
-- The raw API key is generated and retained by the integration owner's secret manager.
create table if not exists public.integration_api_keys (
  key_id text primary key,
  owner_id text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint integration_api_keys_hash_format
    check (key_hash ~ '^[0-9a-fA-F]{64}$')
);

create index if not exists integration_api_keys_owner_idx
  on public.integration_api_keys (owner_id, created_at desc);

create index if not exists integration_api_keys_active_idx
  on public.integration_api_keys (key_hash)
  where revoked_at is null;
