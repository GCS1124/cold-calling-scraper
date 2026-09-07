-- Durable POST retries must resolve to one active search job per key.
-- The request payload already stores the normalized key; an expression index
-- keeps the migration additive without changing the public job table shape.
create unique index if not exists lead_finder_jobs_idempotency_unique_idx
  on public.lead_finder_jobs ((payload->>'idempotencyKey'))
  where payload ? 'idempotencyKey';
