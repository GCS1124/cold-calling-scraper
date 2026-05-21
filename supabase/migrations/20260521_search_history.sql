create extension if not exists pgcrypto;

create table if not exists public.search_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_type text not null,
  city text not null,
  count integer not null,
  location_label text,
  created_at timestamptz not null default now()
);

alter table public.search_history enable row level security;

create policy "Users can read their own search history"
on public.search_history
for select
using (auth.uid() = user_id);

create policy "Users can insert their own search history"
on public.search_history
for insert
with check (auth.uid() = user_id);

grant select, insert on public.search_history to authenticated;
