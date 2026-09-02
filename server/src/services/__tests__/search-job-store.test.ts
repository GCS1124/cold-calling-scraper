import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';

vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const on = vi.fn();

  return {
    Pool: vi.fn(function MockPool() {
      return {
        on,
        query,
        end: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

describe('createSearchJobStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('strips ssl query params before constructing the Postgres pool', async () => {
    vi.stubEnv(
      'POSTGRES_URL',
      'postgres://user:pass@example.com:5432/jobs?sslmode=require&sslaccept=strict',
    );

    const { createSearchJobStore } = await import('../search-job-store');
    const { Pool } = await import('pg');

    const store = createSearchJobStore();
    await store.ensureSchema();

    expect(Pool).toHaveBeenCalledOnce();
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://user:pass@example.com:5432/jobs',
        ssl: {
          rejectUnauthorized: false,
        },
      }),
    );
  });

  it('fails fast on Vercel when durable search storage is not configured', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');

    const { createSearchJobStore } = await import('../search-job-store');
    const store = createSearchJobStore();

    await expect(store.ensureSchema()).rejects.toMatchObject({
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
    });
  });

  it('never exposes more leads than the requested count', async () => {
    const { createSearchJobRecord, toSearchResponse } = await import('../search-job-store');
    const leads = Array.from({ length: 62 }, (_, index): Lead => ({
      id: `lead-${index}`,
      name: `Austin Dentist ${index}`,
      mobile: `+1512555${String(index).padStart(4, '0')}`,
      email: '',
      website: `https://dentist-${index}.example.com`,
      address: `${index} Congress Ave, Austin, TX`,
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'Google Places',
      confidence: 90,
      sourceScore: 90,
      hasEmail: false,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: false,
      scrapedAt: '2026-09-01T00:00:00.000Z',
    }));
    const job = createSearchJobRecord({
      searchId: 'count-cap',
      request: {
        companyType: 'Dentist',
        sourceMode: 'gmb',
        city: 'Austin, TX',
        count: 50,
      },
      query: 'Dentist in Austin, TX',
      locationLabel: 'Austin, TX',
      locationMode: 'local',
      leads,
      status: 'complete',
      progress: {
        discovered: 62,
        enriched: 62,
        totalCandidates: 62,
        requestedCount: 50,
        foundCount: 62,
        duplicatesRemoved: 0,
        currentSource: 'Complete',
        batchesCompleted: 1,
        estimatedRemaining: 0,
      },
    });

    const response = toSearchResponse(job);

    expect(response.leads).toHaveLength(50);
    expect(response.meta.totals.total).toBe(50);
    expect(response.meta.progress.foundCount).toBe(50);
    expect(response.meta.progress.totalCandidates).toBe(62);
  });

  it('allows only one active processing claim for a job', async () => {
    const { createSearchJobRecord, createSearchJobStore } = await import('../search-job-store');
    const store = createSearchJobStore();
    const job = createSearchJobRecord({
      searchId: 'claim-job',
      request: {
        companyType: 'Dentist',
        sourceMode: 'linkedin',
        city: 'Austin, TX',
        count: 50,
      },
      query: 'Dentist in Austin, TX',
      locationLabel: 'Austin, TX',
      locationMode: 'local',
      status: 'discovering',
      progress: {
        discovered: 0,
        enriched: 0,
        totalCandidates: 0,
        requestedCount: 50,
        foundCount: 0,
        duplicatesRemoved: 0,
        currentSource: 'LinkedIn',
        batchesCompleted: 0,
        estimatedRemaining: 50,
      },
    });

    await store.upsert(job);

    const firstClaim = await store.claim('claim-job', 1000, 10_000, 'token-a');
    const secondClaim = await store.claim('claim-job', 1000, 10_000, 'token-b');

    expect(firstClaim?.processingToken).toBe('token-a');
    expect(firstClaim?.processingUntil).toBe(11_000);
    expect(secondClaim).toBeNull();

    firstClaim!.processingToken = undefined;
    firstClaim!.processingUntil = undefined;
    await store.upsert(firstClaim!);

    const afterRelease = await store.claim('claim-job', 1000, 10_000, 'token-b');
    expect(afterRelease?.processingToken).toBe('token-b');
  });
});
