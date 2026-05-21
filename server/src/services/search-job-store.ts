import { sql } from '@vercel/postgres';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchProgress, SearchRequest, SearchResponse, SearchStatus } from '../types/search';

export type SearchJobRecord = {
  searchId: string;
  request: SearchRequest;
  query: string;
  locationLabel: string;
  locationMode: 'local' | 'nationwide';
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

    await sql`
      create table if not exists lead_finder_jobs (
        search_id text primary key,
        payload jsonb not null,
        expires_at bigint not null,
        created_at bigint not null,
        updated_at bigint not null
      )
    `;

    schemaReady = true;
  };

  return {
    ensureSchema,
    get: async (searchId: string) => {
      await ensureSchema();

      const result = await sql`
        select payload
        from lead_finder_jobs
        where search_id = ${searchId}
          and expires_at > ${Date.now()}
      `;

      const payload = result.rows[0]?.payload;
      if (!payload) {
        return null;
      }

      return typeof payload === 'string' ? (JSON.parse(payload) as SearchJobRecord) : (payload as SearchJobRecord);
    },
    upsert: async (job: SearchJobRecord) => {
      await ensureSchema();

      await sql`
        insert into lead_finder_jobs (
          search_id,
          payload,
          expires_at,
          created_at,
          updated_at
        ) values (
          ${job.searchId},
          ${JSON.stringify(job)}::jsonb,
          ${job.expiresAt},
          ${job.createdAt},
          ${job.updatedAt}
        )
        on conflict (search_id) do update set
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `;
    },
    deleteExpired: async (now: number) => {
      await ensureSchema();
      await sql`
        delete from lead_finder_jobs
        where expires_at <= ${now}
      `;
    },
  };
};

export const createSearchJobStore = (): SearchJobStore => {
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    return memoryStore();
  }

  const postgres = postgresStore();
  const memory = memoryStore();
  let useMemoryFallback = false;

  const run = async <T>(operation: (store: SearchJobStore) => Promise<T>): Promise<T> => {
    if (useMemoryFallback) {
      return operation(memory);
    }

    try {
      return await operation(postgres);
    } catch (error) {
      useMemoryFallback = true;
      return operation(memory);
    }
  };

  return {
    ensureSchema: async () => {
      await run((store) => store.ensureSchema());
    },
    get: async (searchId: string) => {
      return run((store) => store.get(searchId));
    },
    upsert: async (job: SearchJobRecord) => {
      await run((store) => store.upsert(job));
    },
    deleteExpired: async (now: number) => {
      await run((store) => store.deleteExpired(now));
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
