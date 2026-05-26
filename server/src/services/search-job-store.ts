import { Pool } from 'pg';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchProgress, SearchRequest, SearchResponse, SearchStatus } from '../types/search';

export type SearchJobRecord = {
  searchId: string;
  request: SearchRequest;
  query: string;
  locationLabel: string;
  locationMode: 'local' | 'nationwide' | 'timezone';
  status: SearchStatus;
  progress: SearchProgress;
  leads: Lead[];
  providerWarnings: ProviderWarning[];
  searchSeeds: string[];
  nextSeedIndex: number;
  discoveryComplete: boolean;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type SearchJobStore = {
  ensureSchema: () => Promise<void>;
  get: (searchId: string) => Promise<SearchJobRecord | null>;
  upsert: (job: SearchJobRecord) => Promise<void>;
  deleteExpired: (now: number) => Promise<void>;
};

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  '';

const useSsl = Boolean(
  connectionString &&
    !/localhost|127\.0\.0\.1|\.local/i.test(connectionString),
);

let pool: Pool | null = null;

const getPool = () => {
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    const url = new URL(connectionString);
    pool = new Pool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
};

const memoryStore = () => {
  const jobs = new Map<string, SearchJobRecord>();

  return {
    ensureSchema: async () => undefined,
    get: async (searchId: string) => jobs.get(searchId) ?? null,
    upsert: async (job: SearchJobRecord) => {
      jobs.set(job.searchId, job);
    },
    deleteExpired: async (now: number) => {
      for (const [searchId, job] of jobs.entries()) {
        if (job.expiresAt <= now) {
          jobs.delete(searchId);
        }
      }
    },
  } satisfies SearchJobStore;
};

const isHiddenWarning = (warning: ProviderWarning) =>
  warning.providerId === 'website-crawl' &&
  /blocked contact crawling|timed out during contact crawling/i.test(warning.message);

const postgresStore = (): SearchJobStore => {
  let schemaReady = false;

  const ensureSchema = async () => {
    if (schemaReady) {
      return;
    }

    const client = getPool();
    if (!client) {
      throw new Error('Missing POSTGRES_URL or POSTGRES_URL_NON_POOLING');
    }

    await client.query(`
      create table if not exists lead_finder_jobs (
        search_id text primary key,
        payload jsonb not null,
        expires_at bigint not null,
        created_at bigint not null,
        updated_at bigint not null
      )
    `);

    schemaReady = true;
  };

  return {
    ensureSchema,
    get: async (searchId: string) => {
      await ensureSchema();

      const client = getPool();
      if (!client) {
        throw new Error('Missing POSTGRES_URL or POSTGRES_URL_NON_POOLING');
      }

      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          select payload
          from lead_finder_jobs
          where search_id = $1
            and expires_at > $2
        `,
        [searchId, Date.now()],
      );

      const payload = result.rows[0]?.payload;
      if (!payload) {
        return null;
      }

      return typeof payload === 'string' ? (JSON.parse(payload) as SearchJobRecord) : (payload as SearchJobRecord);
    },
    upsert: async (job: SearchJobRecord) => {
      await ensureSchema();

      const client = getPool();
      if (!client) {
        throw new Error('Missing POSTGRES_URL or POSTGRES_URL_NON_POOLING');
      }

      await client.query(
        `
          insert into lead_finder_jobs (
            search_id,
            payload,
            expires_at,
            created_at,
            updated_at
          ) values (
            $1,
            $2::jsonb,
            $3,
            $4,
            $5
          )
          on conflict (search_id) do update set
            payload = excluded.payload,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `,
        [
          job.searchId,
          JSON.stringify(job),
          job.expiresAt,
          job.createdAt,
          job.updatedAt,
        ],
      );
    },
    deleteExpired: async (now: number) => {
      await ensureSchema();
      const client = getPool();
      if (!client) {
        throw new Error('Missing POSTGRES_URL or POSTGRES_URL_NON_POOLING');
      }
      await client.query('delete from lead_finder_jobs where expires_at <= $1', [now]);
    },
  };
};

export const createSearchJobStore = (): SearchJobStore => {
  if (!connectionString) {
    return memoryStore();
  }

  const postgres = postgresStore();

  return {
    ensureSchema: async () => {
      await postgres.ensureSchema();
    },
    get: async (searchId: string) => {
      return postgres.get(searchId);
    },
    upsert: async (job: SearchJobRecord) => {
      await postgres.upsert(job);
    },
    deleteExpired: async (now: number) => {
      await postgres.deleteExpired(now);
    },
  };
};

export const toSearchResponse = (job: SearchJobRecord): SearchResponse => ({
  searchId: job.searchId,
  leads: job.leads,
  meta: {
    query: job.query,
    locationLabel: job.locationLabel,
    status: job.status,
    progress: job.progress,
    totals: {
      total: job.leads.length,
      withEmail: job.leads.filter((lead) => lead.hasEmail).length,
      withPhone: job.leads.filter((lead) => lead.hasPhone).length,
      withWebsite: job.leads.filter((lead) => lead.hasWebsite).length,
    },
    providerWarnings: job.providerWarnings.filter((warning) => !isHiddenWarning(warning)),
  },
});
