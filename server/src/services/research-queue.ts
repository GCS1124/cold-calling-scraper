import { randomUUID } from 'node:crypto';

import { Pool, type PoolConfig } from 'pg';

export type ResearchQueueStatus = 'queued' | 'processing' | 'complete' | 'dead';

export type ResearchQueueItem = {
  searchId: string;
  attempts: number;
  status: ResearchQueueStatus;
};

export type ResearchQueue = {
  ensureSchema: () => Promise<void>;
  enqueue: (searchId: string, now: number) => Promise<void>;
  claimNext: (now: number, leaseMs: number, token?: string) => Promise<ResearchQueueItem | null>;
  release: (args: {
    searchId: string;
    token: string;
    status: ResearchQueueStatus;
    now: number;
    retryAt?: number;
    error?: string;
  }) => Promise<void>;
  close: () => Promise<void>;
};

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING?.trim() ||
  process.env.POSTGRES_PRISMA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  '';

const normalizeConnectionString = (value: string) => {
  try {
    const url = new URL(value);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslaccept']) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
};

const shouldUseSsl = (value: string) =>
  Boolean(value) && !/localhost|127\.0\.0\.1|\.local/i.test(value) && !/[?&]sslmode=disable/i.test(value);

const getPool = () => {
  if (!connectionString) {
    return null;
  }

  const config: PoolConfig = {
    connectionString: normalizeConnectionString(connectionString),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 6_000,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  };

  return new Pool(config);
};

const memoryQueue = (): ResearchQueue => {
  const items = new Map<string, ResearchQueueItem & { availableAt: number; leaseUntil?: number; token?: string; error?: string }>();

  return {
    ensureSchema: async () => undefined,
    enqueue: async (searchId, now) => {
      const previous = items.get(searchId);
      items.set(searchId, {
        searchId,
        attempts: previous?.attempts ?? 0,
        status: 'queued',
        availableAt: now,
      });
    },
    claimNext: async (now, leaseMs, token = randomUUID()) => {
      const item = [...items.values()]
        .filter(
          (candidate) =>
            (candidate.status === 'queued' || candidate.status === 'processing') &&
            candidate.availableAt <= now &&
            (candidate.leaseUntil ?? 0) <= now,
        )
        .sort((left, right) => left.availableAt - right.availableAt)[0];

      if (!item) {
        return null;
      }

      item.status = 'processing';
      item.attempts += 1;
      item.leaseUntil = now + leaseMs;
      item.token = token;
      return { searchId: item.searchId, attempts: item.attempts, status: item.status };
    },
    release: async ({ searchId, token, status, now, retryAt, error }) => {
      const item = items.get(searchId);
      if (!item || item.token !== token) {
        return;
      }
      item.status = status;
      item.availableAt = retryAt ?? now;
      item.leaseUntil = undefined;
      item.token = undefined;
      item.error = error;
    },
    close: async () => undefined,
  };
};

const postgresQueue = (pool: Pool): ResearchQueue => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | undefined;

  const ensureSchema = async () => {
    if (schemaReady) return;
    schemaPromise ??= pool
      .query(`
        create table if not exists lead_finder_research_queue (
          search_id text primary key references lead_finder_jobs (search_id) on delete cascade,
          status text not null default 'queued' check (status in ('queued', 'processing', 'complete', 'dead')),
          attempts integer not null default 0,
          available_at bigint not null,
          lease_until bigint,
          lease_token text,
          last_error text,
          created_at bigint not null,
          updated_at bigint not null
        );
        create index if not exists lead_finder_research_queue_ready_idx
          on lead_finder_research_queue (status, available_at);
      `)
      .then(() => {
        schemaReady = true;
      });
    await schemaPromise;
  };

  return {
    ensureSchema,
    enqueue: async (searchId, now) => {
      await ensureSchema();
      await pool.query(
        `
          insert into lead_finder_research_queue
            (search_id, status, attempts, available_at, created_at, updated_at)
          values ($1, 'queued', 0, $2, $2, $2)
          on conflict (search_id) do update set
            status = case when lead_finder_research_queue.status in ('complete', 'dead') then 'queued' else lead_finder_research_queue.status end,
            available_at = case when lead_finder_research_queue.status in ('complete', 'dead') then $2 else lead_finder_research_queue.available_at end,
            lease_until = null,
            lease_token = null,
            last_error = null,
            updated_at = $2
        `,
        [searchId, now],
      );
    },
    claimNext: async (now, leaseMs, token = randomUUID()) => {
      await ensureSchema();
      const result = await pool.query<ResearchQueueItem>(
        `
          with next_item as (
            select search_id
            from lead_finder_research_queue
            where status in ('queued', 'processing')
              and available_at <= $1
              and coalesce(lease_until, 0) <= $1
            order by available_at asc, created_at asc
            for update skip locked
            limit 1
          )
          update lead_finder_research_queue as queue
          set status = 'processing',
              attempts = queue.attempts + 1,
              lease_until = $2,
              lease_token = $3,
              updated_at = $1
          from next_item
          where queue.search_id = next_item.search_id
          returning queue.search_id as "searchId", queue.attempts, queue.status
        `,
        [now, now + leaseMs, token],
      );
      return result.rows[0] ?? null;
    },
    release: async ({ searchId, token, status, now, retryAt, error }) => {
      await ensureSchema();
      await pool.query(
        `
          update lead_finder_research_queue
          set status = $3,
              available_at = $4,
              lease_until = null,
              lease_token = null,
              last_error = $5,
              updated_at = $2
          where search_id = $1
            and lease_token = $6
        `,
        [searchId, now, status, retryAt ?? now, error?.slice(0, 2_000) ?? null, token],
      );
    },
    close: async () => {
      await pool.end();
    },
  };
};

export const createResearchQueue = (): ResearchQueue => {
  const pool = getPool();
  return pool ? postgresQueue(pool) : memoryQueue();
};
