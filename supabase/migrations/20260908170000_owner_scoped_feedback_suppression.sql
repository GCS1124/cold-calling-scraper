-- Operator feedback is private application data. The server writes and reads
-- these tables with the authenticated owner id; the browser never submits
-- phone, email, or other contact values for a feedback event.
alter table if exists public.research_suppression_entries
  add column if not exists owner_id text;

alter table if exists public.research_feedback_events
  add column if not exists owner_id text;

alter table if exists public.research_feedback_events
  add column if not exists event_key text;

create index if not exists research_suppression_owner_lookup_idx
  on public.research_suppression_entries (owner_id, normalized_value)
  where owner_id is not null;

create unique index if not exists research_suppression_owner_value_reason_idx
  on public.research_suppression_entries (owner_id, normalized_value, reason)
  where owner_id is not null and normalized_value is not null;

create index if not exists research_feedback_owner_search_idx
  on public.research_feedback_events (owner_id, search_id, created_at desc)
  where owner_id is not null;

create unique index if not exists research_feedback_owner_event_key_idx
  on public.research_feedback_events (owner_id, event_key)
  where owner_id is not null and event_key is not null;
