alter table public.search_history
  add column if not exists search_id text,
  add column if not exists lead_count integer not null default 0,
  add column if not exists leads jsonb not null default '[]'::jsonb;

create index if not exists search_history_user_created_at_idx
  on public.search_history (user_id, created_at desc);
