import { Pool, type PoolConfig } from 'pg';

import type { Lead } from '../types/lead';
import type {
  ProviderWarning,
  SearchProgress,
  SearchRequest,
  SearchResponse,
  SearchStatus,
} from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import type { NormalizedUsLocation } from './us-location';

export type SearchLocationMode =
  | 'local'
  | 'nationwide'
  | 'timezone'
  | 'region'
  | 'state';

export type SearchJobRecord = {
  schemaVersion: number;
  searchId: string;
  request: SearchRequest;
  query: string;
  locationLabel: string;
  locationMode: SearchLocationMode;
  targetLocation?: NormalizedUsLocation;
  status: SearchStatus;
  progress: SearchProgress;
  leads: Lead[];
  providerWarnings: ProviderWarning[];
  searchSeeds: string[];
  nextSeedIndex: number;
  discoveryComplete: boolean;
  lastProgressAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type SearchJobStore = {
  ensureSchema: () => Promise<void>;
  get: (searchId: string) => Promise<SearchJobRecord | null>;
  upsert: (job: SearchJobRecord) => Promise<void>;
  deleteExpired: (now: number) => Promise<void>;
  close?: () => Promise<void>;
};

export const CURRENT_SCHEMA_VERSION = 2;

const DEFAULT_JOB_TTL_MS = 1000 * 60 * 60 * 6;
const MEMORY_MAX_JOBS = Number(process.env.SEARCH_JOB_MEMORY_MAX_JOBS ?? 500);
const POSTGRES_STATEMENT_TIMEOUT_MS = Number(
  process.env.SEARCH_JOB_POSTGRES_STATEMENT_TIMEOUT_MS ?? 10_000,
);

const normalizeConnectionString = (url: string) => {
  try {
    const parsed = new URL(url);

    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslaccept']) {
      parsed.searchParams.delete(key);
    }

    return parsed.toString();
  } catch {
    return url;
  }
};

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING?.trim() ||
  process.env.POSTGRES_PRISMA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  '';

const sanitizedConnectionString = connectionString
  ? normalizeConnectionString(connectionString)
  : '';

const shouldUseSsl = (url: string) => {
  if (!url) return false;

  if (/localhost|127\.0\.0\.1|\.local/i.test(url)) {
    return false;
  }

  if (/[?&]sslmode=disable/i.test(url)) {
    return false;
  }

  return true;
};

let pool: Pool | null = null;

const getPool = () => {
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    const config: PoolConfig = {
      connectionString: sanitizedConnectionString,
      max: Number(process.env.SEARCH_JOB_POSTGRES_POOL_MAX ?? 2),
      idleTimeoutMillis: Number(process.env.SEARCH_JOB_POSTGRES_IDLE_TIMEOUT_MS ?? 10_000),
      connectionTimeoutMillis: Number(process.env.SEARCH_JOB_POSTGRES_CONNECT_TIMEOUT_MS ?? 6_000),
      statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      query_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      ssl: shouldUseSsl(connectionString)
        ? {
            rejectUnauthorized:
              process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true',
          }
        : undefined,
    };

    pool = new Pool(config);

    pool.on('error', (error) => {
      console.error('[search-job-store] idle postgres client error', error);
    });
  }

  return pool;
};

const nowMs = () => Date.now();

const normalizeSearchId = (searchId: string) => searchId.trim();

const isValidSearchId = (searchId: string) => {
  const normalized = normalizeSearchId(searchId);

  return (
    normalized.length >= 8 &&
    normalized.length <= 128 &&
    /^[a-zA-Z0-9:_-]+$/.test(normalized)
  );
};

const uniqueStrings = (values: string[]) => {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

const warningKey = (warning: ProviderWarning) => {
  return [
    warning.providerId,
    warning.providerName,
    warning.message,
  ].join('|');
};

const dedupeWarnings = (warnings: ProviderWarning[]) => {
  const seen = new Set<string>();
  const deduped: ProviderWarning[] = [];

  for (const warning of warnings) {
    const key = warningKey(warning);

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(warning);
    }
  }

  return deduped;
};

const clampProgress = (progress: SearchProgress): SearchProgress => {
  const safeProgress = {
    ...progress,
  };

  for (const [key, value] of Object.entries(safeProgress)) {
    if (typeof value === 'number') {
      (safeProgress as Record<string, unknown>)[key] = Math.max(0, value);
    }
  }

  return safeProgress;
};

const normalizeLocationMode = (mode: unknown): SearchLocationMode => {
  if (
    mode === 'local' ||
    mode === 'nationwide' ||
    mode === 'timezone' ||
    mode === 'region' ||
    mode === 'state'
  ) {
    return mode;
  }

  return 'local';
};

const sanitizeJob = (job: SearchJobRecord): SearchJobRecord => {
  const currentTime = nowMs();

  if (!isValidSearchId(job.searchId)) {
    throw new Error(`Invalid search id: ${job.searchId}`);
  }

  return {
    ...job,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    searchId: normalizeSearchId(job.searchId),
    query: job.query?.trim() ?? '',
    locationLabel: job.locationLabel?.trim() ?? '',
    locationMode: normalizeLocationMode(job.locationMode),
    progress: clampProgress(job.progress),
    leads: deduplicateLeads(Array.isArray(job.leads) ? job.leads : []),
    providerWarnings: dedupeWarnings(
      Array.isArray(job.providerWarnings) ? job.providerWarnings : [],
    ),
    searchSeeds: uniqueStrings(Array.isArray(job.searchSeeds) ? job.searchSeeds : []),
    nextSeedIndex: Math.min(
      uniqueStrings(Array.isArray(job.searchSeeds) ? job.searchSeeds : []).length,
      Math.max(0, Math.floor(Number(job.nextSeedIndex ?? 0))),
    ),
    discoveryComplete: Boolean(job.discoveryComplete),
    lastProgressAt: Number.isFinite(job.lastProgressAt)
      ? job.lastProgressAt
      : currentTime,
    createdAt: Number.isFinite(job.createdAt)
      ? job.createdAt
      : currentTime,
    updatedAt: currentTime,
    expiresAt: Number.isFinite(job.expiresAt)
      ? job.expiresAt
      : currentTime + DEFAULT_JOB_TTL_MS,
  };
};

const migrateJobPayload = (payload: unknown): SearchJobRecord | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const raw = payload as Partial<SearchJobRecord>;

  if (!raw.searchId || !raw.request || !raw.status || !raw.progress) {
    return null;
  }

  return sanitizeJob({
    schemaVersion: Number(raw.schemaVersion ?? 1),
    searchId: String(raw.searchId),
    request: raw.request,
    query: String(raw.query ?? ''),
    locationLabel: String(raw.locationLabel ?? ''),
    locationMode: normalizeLocationMode(raw.locationMode),
    status: raw.status,
    progress: raw.progress,
    leads: Array.isArray(raw.leads) ? raw.leads : [],
    providerWarnings: Array.isArray(raw.providerWarnings)
      ? raw.providerWarnings
      : [],
    searchSeeds: Array.isArray(raw.searchSeeds) ? raw.searchSeeds : [],
    nextSeedIndex: Number(raw.nextSeedIndex ?? 0),
    discoveryComplete: Boolean(raw.discoveryComplete),
    lastProgressAt: Number(raw.lastProgressAt ?? nowMs()),
    expiresAt: Number(raw.expiresAt ?? nowMs() + DEFAULT_JOB_TTL_MS),
    createdAt: Number(raw.createdAt ?? nowMs()),
    updatedAt: Number(raw.updatedAt ?? nowMs()),
  });
};

const parsePayload = (payload: SearchJobRecord | string | unknown) => {
  try {
    const parsed =
      typeof payload === 'string'
        ? JSON.parse(payload)
        : payload;

    return migrateJobPayload(parsed);
  } catch {
    return null;
  }
};

const memoryStore = (): SearchJobStore => {
  const jobs = new Map<string, SearchJobRecord>();

  const prune = (now: number) => {
    for (const [searchId, job] of jobs.entries()) {
      if (job.expiresAt <= now) {
        jobs.delete(searchId);
      }
    }

    if (jobs.size <= MEMORY_MAX_JOBS) {
      return;
    }

    const oldest = [...jobs.entries()]
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
      .slice(0, jobs.size - MEMORY_MAX_JOBS);

    for (const [searchId] of oldest) {
      jobs.delete(searchId);
    }
  };

  return {
    ensureSchema: async () => undefined,

    get: async (searchId: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      const job = jobs.get(normalized);
      if (!job) return null;

      return job;
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);
      jobs.set(sanitized.searchId, sanitized);

      if (jobs.size > MEMORY_MAX_JOBS) {
        const oldest = [...jobs.entries()]
          .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
          .slice(0, jobs.size - MEMORY_MAX_JOBS);

        for (const [searchId] of oldest) {
          jobs.delete(searchId);
        }
      }
    },

    deleteExpired: async (now: number) => {
      prune(now);
    },
  };
};

const isHiddenWarning = (warning: ProviderWarning) =>
  warning.providerId === 'website-crawl' &&
  /blocked contact crawling|timed out during contact crawling/i.test(warning.message);

const postgresStore = (): SearchJobStore => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | null = null;

  const ensureSchema = async () => {
    if (schemaReady) {
      return;
    }

    if (schemaPromise) {
      return schemaPromise;
    }

    schemaPromise = (async () => {
      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
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

      await client.query(`
        create index if not exists lead_finder_jobs_expires_at_idx
          on lead_finder_jobs (expires_at)
      `);

      await client.query(`
        create index if not exists lead_finder_jobs_updated_at_idx
          on lead_finder_jobs (updated_at)
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

    get: async (searchId: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          select payload
          from lead_finder_jobs
          where search_id = $1
            and expires_at > $2
          limit 1
        `,
        [normalized, nowMs()],
      );

      const payload = result.rows[0]?.payload;

      if (!payload) {
        return null;
      }

      return parsePayload(payload);
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
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
          sanitized.searchId,
          JSON.stringify(sanitized),
          sanitized.expiresAt,
          sanitized.createdAt,
          sanitized.updatedAt,
        ],
      );
    },

    deleteExpired: async (now: number) => {
      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      await client.query(
        `
          delete from lead_finder_jobs
          where expires_at <= $1
        `,
        [now],
      );
    },

    close: async () => {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
};

export const createSearchJobStore = (): SearchJobStore => {
  const fallback = memoryStore();

  if (!connectionString) {
    return fallback;
  }

  const postgres = postgresStore();

  const withFallback = async <T>(
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    label: string,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      console.error(`[search-job-store] postgres ${label} failed; using memory fallback`, error);
      return fallbackOperation();
    }
  };

  return {
    ensureSchema: async () => {
      await withFallback(
        () => postgres.ensureSchema(),
        () => fallback.ensureSchema(),
        'ensureSchema',
      );
    },

    get: async (searchId: string) => {
      return withFallback(
        () => postgres.get(searchId),
        () => fallback.get(searchId),
        'get',
      );
    },

    upsert: async (job: SearchJobRecord) => {
      await withFallback(
        () => postgres.upsert(job),
        () => fallback.upsert(job),
        'upsert',
      );
    },

    deleteExpired: async (now: number) => {
      await withFallback(
        () => postgres.deleteExpired(now),
        () => fallback.deleteExpired(now),
        'deleteExpired',
      );
    },

    close: async () => {
      await postgres.close?.();
    },
  };
};

const countLeadTotals = (leads: Lead[]) => {
  const uniqueLeads = deduplicateLeads(leads);

  return {
    total: uniqueLeads.length,
    withEmail: uniqueLeads.filter((lead) => lead.hasEmail).length,
    withPhone: uniqueLeads.filter((lead) => lead.hasPhone).length,
    withWebsite: uniqueLeads.filter((lead) => lead.hasWebsite).length,
  };
};

export const toSearchResponse = (job: SearchJobRecord): SearchResponse => {
  const leads = deduplicateLeads(job.leads);
  const providerWarnings = dedupeWarnings(job.providerWarnings).filter(
    (warning) => !isHiddenWarning(warning),
  );

  return {
    searchId: job.searchId,
    leads,
    meta: {
      query: job.query,
      locationLabel: job.locationLabel,
      status: job.status,
      progress: job.progress,
      totals: countLeadTotals(leads),
      providerWarnings,
    },
  };
};

export const createSearchJobRecord = (
  params: Pick<
    SearchJobRecord,
    'searchId' | 'request' | 'query' | 'locationLabel' | 'locationMode' | 'progress'
  > &
    Partial<
      Pick<
    SearchJobRecord,
    'status' | 'leads' | 'providerWarnings' | 'searchSeeds' | 'nextSeedIndex' | 'discoveryComplete' | 'expiresAt'
      >
    >,
): SearchJobRecord => {
  const now = nowMs();

  return sanitizeJob({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    searchId: params.searchId,
    request: params.request,
    query: params.query,
    locationLabel: params.locationLabel,
    locationMode: params.locationMode,
    status: params.status ?? 'queued',
    progress: params.progress,
    leads: params.leads ?? [],
    providerWarnings: params.providerWarnings ?? [],
    searchSeeds: params.searchSeeds ?? [],
    nextSeedIndex: params.nextSeedIndex ?? 0,
    discoveryComplete: params.discoveryComplete ?? false,
    lastProgressAt: now,
    expiresAt: params.expiresAt ?? now + DEFAULT_JOB_TTL_MS,
    createdAt: now,
    updatedAt: now,
  });
};
