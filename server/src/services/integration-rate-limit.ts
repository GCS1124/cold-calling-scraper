import { createHash } from 'node:crypto';

import type { RequestLike } from '../http/search-http-contract';
import {
  getSearchDatabasePool,
  hasSearchDatabase,
  isSearchJobVercelRuntime,
  SearchPersistenceError,
} from './search-job-store';

const rateLimitWindowMs = 60_000;
const defaultRateLimit = 60;
const maxRateLimit = 10_000;

export type IntegrationRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export type IntegrationRateLimitStore = {
  consume: (key: string, windowStart: number) => Promise<number>;
};

const parseLimit = () => {
  const configured = Number(process.env.LEAD_FINDER_INTEGRATION_RATE_LIMIT_PER_MINUTE);
  if (!Number.isFinite(configured) || configured < 1) return defaultRateLimit;
  return Math.min(Math.floor(configured), maxRateLimit);
};

const requireDurableRateLimit = () =>
  process.env.LEAD_FINDER_INTEGRATION_REQUIRE_DURABLE_RATE_LIMIT?.trim().toLowerCase() === 'true';

const memoryStore = (): IntegrationRateLimitStore => {
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

const postgresStore = (): IntegrationRateLimitStore => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | undefined;

  const ensureSchema = async () => {
    if (schemaReady) return;
    schemaPromise ??= (async () => {
      const pool = getSearchDatabasePool();
      if (!pool) throw new Error('Missing Postgres connection string');

      await pool.query(`
        create table if not exists public.integration_rate_limit_buckets (
          bucket_key text not null,
          window_start bigint not null,
          request_count integer not null,
          updated_at timestamptz not null default now(),
          primary key (bucket_key, window_start)
        );
        create index if not exists integration_rate_limit_updated_idx
          on public.integration_rate_limit_buckets (updated_at);
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
          insert into public.integration_rate_limit_buckets (
            bucket_key, window_start, request_count
          ) values ($1, $2, 1)
          on conflict (bucket_key, window_start)
          do update set
            request_count = public.integration_rate_limit_buckets.request_count + 1,
            updated_at = now()
          returning request_count
        `,
        [key, windowStart],
      );

      await pool
        .query(
          `
            delete from public.integration_rate_limit_buckets
            where window_start < $1 - 2
          `,
          [windowStart],
        )
        .catch(() => undefined);

      return Number(result.rows[0]?.request_count ?? 1);
    },
  };
};

const createDefaultStore = (): IntegrationRateLimitStore => {
  const fallback = memoryStore();
  if (!hasSearchDatabase()) {
    if (isSearchJobVercelRuntime() && requireDurableRateLimit()) {
      return {
        consume: async () => {
          throw new SearchPersistenceError(
            'Distributed integration rate limiting is not configured. Add a Postgres connection string before accepting production API traffic.',
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
        if (isSearchJobVercelRuntime() && requireDurableRateLimit()) {
          console.error('[integration-rate-limit] durable counter failed', error);
          throw new SearchPersistenceError(
            'Distributed integration rate limiting is temporarily unavailable. Try again later.',
          );
        }

        console.error('[integration-rate-limit] using process-local fallback', error);
        return fallback.consume(key, windowStart);
      }
    },
  };
};

export const getIntegrationRateLimitKey = (request: RequestLike) => {
  const headers = request.headers ?? {};
  const headerName = Object.keys(headers).find((key) => {
    const normalized = key.toLowerCase();
    return normalized === 'x-api-key' || normalized === 'authorization';
  });
  const value = headerName ? headers[headerName] : undefined;
  const credential = (Array.isArray(value) ? value[0] : value)?.trim() || 'anonymous';
  return `credential:${createHash('sha256').update(credential, 'utf8').digest('hex')}`;
};

export const createIntegrationRateLimiter = (
  store: IntegrationRateLimitStore = createDefaultStore(),
  limit = parseLimit(),
) => ({
  consume: async (request: RequestLike): Promise<IntegrationRateLimitResult> => {
    const now = Date.now();
    const windowStart = Math.floor(now / rateLimitWindowMs);
    const resetAt = (windowStart + 1) * rateLimitWindowMs;
    const count = await store.consume(getIntegrationRateLimitKey(request), windowStart);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  },
});

export const integrationRateLimiter = createIntegrationRateLimiter();
