import type { RequestLike } from '../http/search-http-contract';
import {
  getSearchDatabasePool,
  hasSearchDatabase,
  isSearchJobVercelRuntime,
  SearchPersistenceError,
} from './search-job-store';
import { getIntegrationRateLimitKey } from './integration-rate-limit';

const quotaWindowMs = 24 * 60 * 60 * 1_000;
const maxQuota = 1_000_000;

export type IntegrationQuotaResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export type IntegrationQuotaStore = {
  consume: (key: string, windowStart: number) => Promise<number>;
};

const parseQuota = () => {
  const configured = Number(process.env.LEAD_FINDER_INTEGRATION_DAILY_REQUEST_QUOTA);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.min(Math.floor(configured), maxQuota);
};

const requireDurableQuota = () =>
  process.env.LEAD_FINDER_INTEGRATION_REQUIRE_DURABLE_QUOTA?.trim().toLowerCase() === 'true';

const memoryStore = (): IntegrationQuotaStore => {
  const counters = new Map<string, { windowStart: number; count: number }>();

  return {
    consume: async (key, windowStart) => {
      const current = counters.get(key);
      const next =
        current?.windowStart === windowStart
          ? { windowStart, count: current.count + 1 }
          : { windowStart, count: 1 };
      counters.set(key, next);

      if (counters.size > 10_000) {
        for (const [entryKey, entry] of counters) {
          if (entry.windowStart !== windowStart) counters.delete(entryKey);
        }
      }

      return next.count;
    },
  };
};

const postgresStore = (): IntegrationQuotaStore => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | undefined;

  const ensureSchema = async () => {
    if (schemaReady) return;
    schemaPromise ??= (async () => {
      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      await pool.query(`
        create table if not exists public.integration_quota_buckets (
          bucket_key text not null,
          window_start bigint not null,
          request_count integer not null,
          updated_at timestamptz not null default now(),
          primary key (bucket_key, window_start)
        );
        create index if not exists integration_quota_updated_idx
          on public.integration_quota_buckets (updated_at);
      `);
      schemaReady = true;
    })();

    try {
      await schemaPromise;
    } finally {
      schemaPromise = undefined;
    }
  };

  return {
    consume: async (key, windowStart) => {
      await ensureSchema();
      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      const result = await pool.query<{ request_count: number }>(
        `
          insert into public.integration_quota_buckets (
            bucket_key, window_start, request_count
          ) values ($1, $2, 1)
          on conflict (bucket_key, window_start)
          do update set
            request_count = public.integration_quota_buckets.request_count + 1,
            updated_at = now()
          returning request_count
        `,
        [key, windowStart],
      );

      await pool
        .query(
          `
            delete from public.integration_quota_buckets
            where window_start < $1 - 2
          `,
          [windowStart],
        )
        .catch(() => undefined);

      return Number(result.rows[0]?.request_count ?? 1);
    },
  };
};

const createDefaultStore = (): IntegrationQuotaStore => {
  const fallback = memoryStore();
  if (!hasSearchDatabase()) {
    if (isSearchJobVercelRuntime() && requireDurableQuota()) {
      return {
        consume: async () => {
          throw new SearchPersistenceError(
            'Distributed integration quotas are not configured. Add a Postgres connection string before accepting quota-controlled production traffic.',
          );
        },
      };
    }
    return fallback;
  }

  const durable = postgresStore();
  return {
    consume: async (key, windowStart) => {
      try {
        return await durable.consume(key, windowStart);
      } catch (error) {
        if (isSearchJobVercelRuntime() && requireDurableQuota()) {
          console.error('[integration-quota] durable counter failed', error);
          throw new SearchPersistenceError(
            'Distributed integration quotas are temporarily unavailable. Try again later.',
          );
        }

        console.error('[integration-quota] using process-local fallback', error);
        return fallback.consume(key, windowStart);
      }
    },
  };
};

export const createIntegrationQuotaEnforcer = (
  store: IntegrationQuotaStore = createDefaultStore(),
  limit = parseQuota(),
) => ({
  consume: async (request: RequestLike): Promise<IntegrationQuotaResult> => {
    const now = Date.now();
    const windowStart = Math.floor(now / quotaWindowMs);
    const resetAt = (windowStart + 1) * quotaWindowMs;

    if (limit <= 0) {
      return { allowed: true, limit: 0, remaining: 0, resetAt };
    }

    const count = await store.consume(getIntegrationRateLimitKey(request), windowStart);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  },
});

export const integrationQuotaEnforcer = createIntegrationQuotaEnforcer();
