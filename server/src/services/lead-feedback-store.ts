import type { PoolClient } from 'pg';

import type { LeadFeedbackEventType } from '../../../shared/lead-feedback';
import {
  getSearchDatabasePool,
  hasSearchDatabase,
  isSearchJobVercelRuntime,
  SearchPersistenceError,
} from './search-job-store';

export type RecordLeadFeedbackInput = {
  searchId: string;
  ownerId: string;
  leadId: string;
  eventType: LeadFeedbackEventType;
  entityKey: string;
  suppressionKeys: string[];
  reason?: string;
};

export type LeadFeedbackStore = {
  ensureSchema: () => Promise<void>;
  getSuppressionKeys: (ownerId: string) => Promise<Set<string>>;
  recordFeedback: (input: RecordLeadFeedbackInput) => Promise<{ created: boolean }>;
};

const safeOwnerId = (ownerId: string) => {
  const value = ownerId.trim();
  return value.length > 0 && value.length <= 256 ? value : '';
};

const safeKey = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  /^[a-z0-9:|./_@+\- ]+$/i.test(value);

const normalizeKeys = (values: string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(safeKey))];

const safeFeedbackInput = (input: RecordLeadFeedbackInput) => ({
  ...input,
  searchId: input.searchId.trim().slice(0, 128),
  ownerId: safeOwnerId(input.ownerId),
  leadId: input.leadId.trim().slice(0, 160),
  entityKey: input.entityKey.trim().slice(0, 512),
  suppressionKeys: normalizeKeys(input.suppressionKeys),
  reason: input.reason?.trim().slice(0, 500) || undefined,
});

const unavailableStore = (message: string): LeadFeedbackStore => {
  const fail = async (): Promise<never> => {
    throw new SearchPersistenceError(message);
  };

  return {
    ensureSchema: fail,
    getSuppressionKeys: fail,
    recordFeedback: fail,
  };
};

const memoryStore = (): LeadFeedbackStore => {
  const suppressions = new Map<string, Map<string, number | undefined>>();
  const feedbackKeys = new Set<string>();

  const prune = (ownerId: string) => {
    const entries = suppressions.get(ownerId);
    if (!entries) return;

    const now = Date.now();
    for (const [key, expiresAt] of entries) {
      if (expiresAt !== undefined && expiresAt <= now) {
        entries.delete(key);
      }
    }

    if (!entries.size) suppressions.delete(ownerId);
  };

  return {
    ensureSchema: async () => undefined,

    getSuppressionKeys: async (ownerId: string) => {
      const normalizedOwner = safeOwnerId(ownerId);
      if (!normalizedOwner) return new Set<string>();
      prune(normalizedOwner);
      return new Set(suppressions.get(normalizedOwner)?.keys() ?? []);
    },

    recordFeedback: async (input: RecordLeadFeedbackInput) => {
      const normalized = safeFeedbackInput(input);
      if (!normalized.ownerId) {
        throw new SearchPersistenceError('An authenticated owner is required for lead feedback.');
      }

      const eventKey = [
        normalized.searchId,
        normalized.leadId,
        normalized.eventType,
      ].join('|');
      if (feedbackKeys.has(`${normalized.ownerId}|${eventKey}`)) {
        return { created: false };
      }

      feedbackKeys.add(`${normalized.ownerId}|${eventKey}`);
      if (normalized.suppressionKeys.length) {
        const entries = suppressions.get(normalized.ownerId) ?? new Map();
        for (const key of normalized.suppressionKeys) entries.set(key, undefined);
        suppressions.set(normalized.ownerId, entries);
      }

      return { created: true };
    },
  };
};

const runTransaction = async <T>(
  client: PoolClient,
  operation: (transaction: PoolClient) => Promise<T>,
) => {
  await client.query('begin');
  try {
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
};

const postgresStore = (): LeadFeedbackStore => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | null = null;

  const ensureSchema = async () => {
    if (schemaReady) return;
    if (schemaPromise) return schemaPromise;

    schemaPromise = (async () => {
      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      await pool.query(`
        create table if not exists public.research_suppression_entries (
          id uuid primary key default gen_random_uuid(),
          owner_id text,
          entity_key text,
          normalized_value text,
          reason text not null,
          created_at timestamptz not null default now(),
          expires_at timestamptz
        );
        alter table public.research_suppression_entries
          add column if not exists owner_id text;
        create table if not exists public.research_feedback_events (
          id uuid primary key default gen_random_uuid(),
          owner_id text,
          search_id text,
          entity_key text,
          event_type text not null,
          event_key text,
          payload jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        );
        alter table public.research_feedback_events
          add column if not exists owner_id text;
        alter table public.research_feedback_events
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
      `);
      schemaReady = true;
    })();

    try {
      await schemaPromise;
    } finally {
      schemaPromise = null;
    }
  };

  return {
    ensureSchema,

    getSuppressionKeys: async (ownerId: string) => {
      const normalizedOwner = safeOwnerId(ownerId);
      if (!normalizedOwner) return new Set<string>();
      await ensureSchema();

      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      const result = await pool.query<{ normalized_value: string | null }>(
        `
          select normalized_value
          from public.research_suppression_entries
          where owner_id = $1
            and normalized_value is not null
            and (expires_at is null or expires_at > now())
        `,
        [normalizedOwner],
      );

      return new Set(
        result.rows
          .map((row) => row.normalized_value?.trim() ?? '')
          .filter(safeKey),
      );
    },

    recordFeedback: async (input: RecordLeadFeedbackInput) => {
      const normalized = safeFeedbackInput(input);
      if (!normalized.ownerId) {
        throw new SearchPersistenceError('An authenticated owner is required for lead feedback.');
      }
      if (!normalized.searchId || !normalized.leadId || !safeKey(normalized.entityKey)) {
        throw new Error('Invalid lead feedback identity');
      }

      await ensureSchema();
      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      const eventKey = [
        normalized.searchId,
        normalized.leadId,
        normalized.eventType,
      ].join('|');
      const client = await pool.connect();
      try {
        return await runTransaction(client, async (transaction) => {
          const event = await transaction.query(
            `
              insert into public.research_feedback_events (
                owner_id, search_id, entity_key, event_type, event_key, payload
              ) values ($1, $2, $3, $4, $5, $6::jsonb)
              on conflict do nothing
              returning id
            `,
            [
              normalized.ownerId,
              normalized.searchId,
              normalized.entityKey,
              normalized.eventType,
              eventKey,
              JSON.stringify(normalized.reason ? { reason: normalized.reason } : {}),
            ],
          );

          for (const suppressionKey of normalized.suppressionKeys) {
            await transaction.query(
              `
                insert into public.research_suppression_entries (
                  owner_id, entity_key, normalized_value, reason
                ) values ($1, $2, $3, $4)
                on conflict do nothing
              `,
              [normalized.ownerId, normalized.entityKey, suppressionKey, normalized.eventType],
            );
          }

          return { created: Boolean(event.rows[0]) };
        });
      } finally {
        client.release();
      }
    },
  };
};

export const createLeadFeedbackStore = (): LeadFeedbackStore => {
  const fallback = memoryStore();

  if (!hasSearchDatabase()) {
    return isSearchJobVercelRuntime()
      ? unavailableStore(
          'Lead feedback persistence is not configured. Add a Postgres connection string before using workspace suppression.',
        )
      : fallback;
  }

  const postgres = postgresStore();
  const withFallback = async <T>(
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    label: string,
  ) => {
    try {
      return await operation();
    } catch (error) {
      if (isSearchJobVercelRuntime()) {
        console.error(`[lead-feedback-store] postgres ${label} failed`, error);
        throw new SearchPersistenceError(
          `Lead feedback persistence is unavailable while ${label}. Check the Postgres connection settings and try again.`,
        );
      }

      console.error(`[lead-feedback-store] postgres ${label} failed; using memory fallback`, error);
      return fallbackOperation();
    }
  };

  return {
    ensureSchema: () => withFallback(postgres.ensureSchema, fallback.ensureSchema, 'ensureSchema'),
    getSuppressionKeys: (ownerId) =>
      withFallback(
        () => postgres.getSuppressionKeys(ownerId),
        () => fallback.getSuppressionKeys(ownerId),
        'getSuppressionKeys',
      ),
    recordFeedback: (input) =>
      withFallback(
        () => postgres.recordFeedback(input),
        () => fallback.recordFeedback(input),
        'recordFeedback',
      ),
  };
};
