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
import { persistNormalizedResearch } from './research-normalizer';
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
  /** Stable lead ids used to resume public LinkedIn contact enrichment in batches. */
  enrichmentQueue?: string[];
  enrichmentCursor?: number;
  discoveryComplete: boolean;
  googleMapsUnavailable?: boolean;
  lastProgressAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  processingToken?: string;
  processingUntil?: number;
  cancelRequested?: boolean;
};

export type SearchJobStore = {
  ensureSchema: () => Promise<void>;
  get: (searchId: string) => Promise<SearchJobRecord | null>;
  claim: (
    searchId: string,
    now: number,
    leaseMs: number,
    token: string,
  ) => Promise<SearchJobRecord | null>;
  upsert: (job: SearchJobRecord) => Promise<void>;
  requestCancel: (searchId: string, now: number) => Promise<SearchJobRecord | null>;
  deleteExpired: (now: number) => Promise<void>;
  close?: () => Promise<void>;
};

export class SearchPersistenceError extends Error {
  readonly code = 'SEARCH_PERSISTENCE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SearchPersistenceError';
  }
}

export const isSearchPersistenceError = (
  error: unknown,
): error is SearchPersistenceError =>
  error instanceof SearchPersistenceError ||
  (error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE');

export const CURRENT_SCHEMA_VERSION = 4;

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

const isVercelRuntime = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

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
    enrichmentQueue: Array.isArray(job.enrichmentQueue)
      ? uniqueStrings(job.enrichmentQueue)
      : undefined,
    enrichmentCursor: Number.isFinite(job.enrichmentCursor)
      ? Math.max(0, Math.floor(job.enrichmentCursor as number))
      : undefined,
    discoveryComplete: Boolean(job.discoveryComplete),
    lastProgressAt: Number.isFinite(job.lastProgressAt)
      ? job.lastProgressAt
      : currentTime,
    createdAt: Number.isFinite(job.createdAt)
      ? job.createdAt
      : currentTime,
    updatedAt: currentTime,
    processingToken:
      typeof job.processingToken === 'string' && job.processingToken.trim()
        ? job.processingToken.trim()
        : undefined,
    processingUntil: Number.isFinite(job.processingUntil)
      ? job.processingUntil
      : undefined,
    cancelRequested:
      typeof job.cancelRequested === 'boolean' ? job.cancelRequested : undefined,
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
    enrichmentQueue: Array.isArray(raw.enrichmentQueue) ? raw.enrichmentQueue : undefined,
    enrichmentCursor: Number(raw.enrichmentCursor ?? 0),
    discoveryComplete: Boolean(raw.discoveryComplete),
    googleMapsUnavailable: Boolean(raw.googleMapsUnavailable),
    lastProgressAt: Number(raw.lastProgressAt ?? nowMs()),
    expiresAt: Number(raw.expiresAt ?? nowMs() + DEFAULT_JOB_TTL_MS),
    createdAt: Number(raw.createdAt ?? nowMs()),
    updatedAt: Number(raw.updatedAt ?? nowMs()),
    processingToken:
      typeof raw.processingToken === 'string' ? raw.processingToken : undefined,
    processingUntil: Number.isFinite(raw.processingUntil)
      ? raw.processingUntil
      : undefined,
    cancelRequested:
      typeof raw.cancelRequested === 'boolean' ? raw.cancelRequested : undefined,
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

const unavailableStore = (message: string): SearchJobStore => {
  const fail = async (): Promise<never> => {
    throw new SearchPersistenceError(message);
  };

  return {
    ensureSchema: fail,
    get: fail,
    claim: fail,
    upsert: fail,
    requestCancel: fail,
    deleteExpired: fail,
  };
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

    claim: async (searchId: string, now: number, leaseMs: number, token: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      const job = jobs.get(normalized);
      if (
        !job ||
        job.cancelRequested ||
        !['queued', 'discovering', 'enriching'].includes(job.status) ||
        (job.processingUntil ?? 0) > now
      ) {
        return null;
      }

      const claimed = {
        ...job,
        processingToken: token,
        processingUntil: now + leaseMs,
        updatedAt: now,
      };
      jobs.set(normalized, claimed);
      return claimed;
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);
      const existing = jobs.get(sanitized.searchId);
      const cancelledDuringWork =
        existing?.cancelRequested === true &&
        sanitized.cancelRequested !== false &&
        sanitized.status !== 'cancelled';
      jobs.set(
        sanitized.searchId,
        cancelledDuringWork
          ? {
              ...sanitized,
              cancelRequested: true,
              status: 'cancelled',
              progress: { ...sanitized.progress, currentSource: 'Cancelled' },
            }
          : sanitized,
      );

      if (jobs.size > MEMORY_MAX_JOBS) {
        const oldest = [...jobs.entries()]
          .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
          .slice(0, jobs.size - MEMORY_MAX_JOBS);

        for (const [searchId] of oldest) {
          jobs.delete(searchId);
        }
      }
    },

    requestCancel: async (searchId: string, now: number) => {
      const normalized = normalizeSearchId(searchId);
      const job = jobs.get(normalized);

      if (!job || ['complete', 'failed', 'cancelled'].includes(job.status)) {
        return job ?? null;
      }

      const cancelled = sanitizeJob({
        ...job,
        cancelRequested: true,
        status: 'cancelled',
        updatedAt: now,
        progress: { ...job.progress, currentSource: 'Cancelled' },
      });
      jobs.set(normalized, cancelled);
      return cancelled;
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

      // Keep cold-start schema setup to one database round-trip. Snapshot reads
      // share the same serverless invocation budget as provider discovery.
      await client.query(`
        create table if not exists lead_finder_jobs (
          search_id text primary key,
          payload jsonb not null,
          expires_at bigint not null,
          created_at bigint not null,
          updated_at bigint not null
        );
        create index if not exists lead_finder_jobs_expires_at_idx
          on lead_finder_jobs (expires_at);
        create index if not exists lead_finder_jobs_updated_at_idx
          on lead_finder_jobs (updated_at);
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

    claim: async (searchId: string, now: number, leaseMs: number, token: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const leaseUntil = now + leaseMs;
      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          update lead_finder_jobs
          set payload = jsonb_set(
            jsonb_set(payload, '{processingToken}', to_jsonb($3::text), true),
            '{processingUntil}', to_jsonb($2::bigint), true
          ),
          updated_at = $4
          where search_id = $1
            and expires_at > $4
            and coalesce(
              case
                when payload->>'processingUntil' ~ '^[0-9]+$'
                  then (payload->>'processingUntil')::bigint
                else 0
              end,
              0
            ) <= $4
            and coalesce(payload->>'status', '') in ('queued', 'discovering', 'enriching')
            and coalesce(payload->>'cancelRequested', 'false') <> 'true'
          returning payload
        `,
        [normalized, leaseUntil, token, now],
      );

      return parsePayload(result.rows[0]?.payload);
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const persistedResult = await client.query<{
        payload: SearchJobRecord | string;
      }>(
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
            payload = case
              when lead_finder_jobs.payload->>'cancelRequested' = 'true'
                and excluded.payload->>'cancelRequested' is distinct from 'false'
                and excluded.payload->>'status' <> 'cancelled'
                then jsonb_set(
                  jsonb_set(
                    jsonb_set(excluded.payload, '{cancelRequested}', 'true'::jsonb, true),
                    '{status}', '"cancelled"'::jsonb, true
                  ),
                  '{progress,currentSource}', '"Cancelled"'::jsonb, true
                )
              else excluded.payload
            end,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
          returning payload
        `,
        [
          sanitized.searchId,
          JSON.stringify(sanitized),
          sanitized.expiresAt,
          sanitized.createdAt,
          sanitized.updatedAt,
        ],
      );

      const persistedJob = parsePayload(persistedResult.rows[0]?.payload);
      if (persistedJob && ['complete', 'failed', 'cancelled'].includes(persistedJob.status)) {
        try {
          await persistNormalizedResearch(client, persistedJob);
        } catch (error) {
          console.error('[search-job-store] normalized research persistence skipped', error);
        }
      }
    },

    requestCancel: async (searchId: string, now: number) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const result = await client.query<{ payload: SearchJobRecord | string }>(
        `
          update lead_finder_jobs
          set payload = jsonb_set(
            jsonb_set(
              jsonb_set(payload, '{cancelRequested}', 'true'::jsonb, true),
              '{status}', '"cancelled"'::jsonb, true
            ),
            '{progress,currentSource}', '"Cancelled"'::jsonb, true
          ),
          updated_at = $2
          where search_id = $1
            and expires_at > $2
            and coalesce(payload->>'status', '') in ('queued', 'discovering', 'enriching')
          returning payload
        `,
        [normalized, now],
      );

      return parsePayload(result.rows[0]?.payload);
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
    if (isVercelRuntime) {
      return unavailableStore(
        'Search persistence is not configured. Add a Postgres connection string to the Vercel project before running searches.',
      );
    }

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
      if (isVercelRuntime) {
        console.error(`[search-job-store] postgres ${label} failed`, error);
        throw new SearchPersistenceError(
          `Search persistence is unavailable while ${label}. Check the Vercel Postgres connection settings and try again.`,
        );
      }

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

    claim: async (searchId: string, now: number, leaseMs: number, token: string) => {
      return withFallback(
        () => postgres.claim(searchId, now, leaseMs, token),
        () => fallback.claim(searchId, now, leaseMs, token),
        'claim',
      );
    },

    upsert: async (job: SearchJobRecord) => {
      await withFallback(
        () => postgres.upsert(job),
        () => fallback.upsert(job),
        'upsert',
      );
    },

    requestCancel: async (searchId: string, now: number) => {
      return withFallback(
        () => postgres.requestCancel(searchId, now),
        () => fallback.requestCancel(searchId, now),
        'requestCancel',
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
  const leads = deduplicateLeads(job.leads).slice(0, job.request.count);
  const providerWarnings = dedupeWarnings(job.providerWarnings).filter(
    (warning) => !isHiddenWarning(warning),
  );
  const progress = {
    ...job.progress,
    foundCount: leads.length,
    estimatedRemaining: Math.max(0, job.request.count - leads.length),
  };

  return {
    searchId: job.searchId,
    leads,
    meta: {
      query: job.query,
      locationLabel: job.locationLabel,
      researchDepth: job.request.researchDepth ?? 'verified',
      researchBrief: job.request.researchBrief,
      status: job.status,
      progress,
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
