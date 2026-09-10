import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead, ResearchCandidate } from '../../types/lead';

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
      listingUrl: `https://www.google.com/maps/place/dentist-${index}`,
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
    expect(response.meta.execution).toMatchObject({
      path: 'durable',
      pollable: true,
      resumable: true,
      startedAt: expect.any(String),
      lastProgressAt: expect.any(String),
      completedAt: expect.any(String),
    });
    const inProgress = toSearchResponse({ ...job, status: 'discovering', leads: [
      { ...leads[0]!, contactEvidence: [] }, leads[1]!,
    ] });
    expect(inProgress.leads).toHaveLength(1);
    expect(inProgress.meta.progress.foundCount).toBe(1);
    expect(inProgress.meta.progress.totalCandidates).toBe(62);
    expect(inProgress.meta.execution).toMatchObject({
      path: 'durable',
      pollable: true,
      resumable: true,
    });
    expect(inProgress.meta.execution).not.toHaveProperty('completedAt');
    expect(job.leads).toHaveLength(62);
    const emptyCompletion = toSearchResponse({ ...job, leads: [{ ...leads[0]!, contactEvidence: [] }] });
    expect(emptyCompletion.meta.status).toBe('failed');
    expect(emptyCompletion.meta.progress.phoneExcludedCount).toBe(1);
    expect(emptyCompletion.meta.providerWarnings.some((warning) => warning.providerId === 'no-usable-results')).toBe(true);
  });

  it('sanitizes unsafe URLs at the durable response boundary', async () => {
    const { createSearchJobRecord, toSearchResponse } = await import('../search-job-store');
    const contactEvidence = [{
      field: 'phone' as const,
      value: '+15125550199',
      sourceUrl: 'https://maps.google.com/maps/place/example',
      sourceName: 'Google Places',
      sourceKind: 'business_listing' as const,
      association: 'business' as const,
      observedAt: '2026-09-01T00:00:00.000Z',
    }];
    const lead: Lead = {
      id: 'unsafe-persisted-lead',
      name: 'Austin Dentist',
      headline: 'Owner',
      mobile: '+15125550199',
      email: '',
      website: 'http://127.0.0.1/admin',
      listingUrl: 'https://user:password@public.example/listing',
      contactSourceUrl: 'http://localhost/contact',
      decisionMakerSourceUrl: 'https://[::1]/profile',
      publicSocialLinks: [{ platform: 'LinkedIn', url: 'http://192.168.1.10/profile' }],
      evidence: [{
        sourceUrl: 'https://[::1]/evidence',
        sourceName: 'Unsafe source',
        claim: 'Phone listed',
        status: 'confirmed',
        observedAt: '2026-09-01T00:00:00.000Z',
      }],
      contactEvidence,
      address: '1 Congress Ave, Austin, TX',
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
    };
    const job = createSearchJobRecord({
      searchId: 'unsafe-response',
      request: {
        companyType: 'Dentist',
        sourceMode: 'gmb',
        city: 'Austin, TX',
        count: 1,
      },
      query: 'Dentist in Austin, TX',
      locationLabel: 'Austin, TX',
      locationMode: 'local',
      leads: [],
      status: 'complete',
      progress: {
        discovered: 1,
        enriched: 1,
        totalCandidates: 1,
        requestedCount: 1,
        foundCount: 1,
        duplicatesRemoved: 0,
        currentSource: 'Complete',
        batchesCompleted: 1,
        estimatedRemaining: 0,
      },
    });

    const unsafeResearchCandidate: ResearchCandidate = {
      id: 'unsafe-research-candidate',
      name: 'Austin Dentist',
      website: 'http://127.0.0.1/research',
      profileUrl: 'https://user:password@public.example/profile',
      socialLinks: [
        { platform: 'LinkedIn', url: 'http://192.168.1.10/profile' },
        { platform: 'Website', url: 'https://safe.example/profile' },
      ],
      sourceUrls: ['http://localhost/source', 'https://safe.example/source'],
      grounded: true,
      status: 'needs_phone_validation',
      discoveredAt: '2026-09-01T00:00:00.000Z',
    };
    const response = toSearchResponse({
      ...job,
      leads: [lead],
      researchCandidates: [unsafeResearchCandidate],
    });
    const [sanitized] = response.leads;
    const [sanitizedResearch] = response.researchCandidates ?? [];

    expect(sanitized?.mobile).toBe('+1 512 555 0199');
    expect(sanitized?.website).toBe('');
    expect(sanitized?.listingUrl).toBeUndefined();
    expect(sanitized?.contactSourceUrl).toBeUndefined();
    expect(sanitized?.decisionMakerSourceUrl).toBeUndefined();
    expect(sanitized?.publicSocialLinks).toBeUndefined();
    expect(sanitized?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: 'https://maps.google.com/maps/place/example',
        }),
      ]),
    );
    expect(
      sanitized?.evidence?.some((item) => item.sourceUrl.includes('::1')),
    ).toBe(false);
    expect(sanitizedResearch?.website).toBeUndefined();
    expect(sanitizedResearch?.profileUrl).toBeUndefined();
    expect(sanitizedResearch?.sourceUrls).toEqual(['https://safe.example/source']);
    expect(sanitizedResearch?.socialLinks).toEqual([
      { platform: 'Website', url: 'https://safe.example/profile' },
    ]);
  });

  it('reuses a durable memory job for the same idempotency key and rejects changed criteria', async () => {
    const { createSearchJobRecord, createSearchJobStore } = await import('../search-job-store');
    const store = createSearchJobStore();
    const job = createSearchJobRecord({
      searchId: 'idempotency-job',
      idempotencyKey: 'search-retry-42',
      requestFingerprint: 'fingerprint-a',
      request: {
        companyType: 'Dentist',
        sourceMode: 'gmb',
        city: 'Austin, TX',
        count: 50,
      },
      query: 'Dentist in Austin, TX',
      locationLabel: 'Austin, TX',
      locationMode: 'local',
      status: 'queued',
      progress: {
        discovered: 0,
        enriched: 0,
        totalCandidates: 0,
        requestedCount: 50,
        foundCount: 0,
        duplicatesRemoved: 0,
        currentSource: 'Queued',
        batchesCompleted: 0,
        estimatedRemaining: 50,
      },
    });

    await store.upsert(job);

    await expect(
      store.getByIdempotencyKey('search-retry-42', 'fingerprint-a', Date.now()),
    ).resolves.toMatchObject({ searchId: 'idempotency-job' });
    await expect(
      store.getByIdempotencyKey('search-retry-42', 'fingerprint-b', Date.now()),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('allows only one active processing claim for a job', async () => {
    const { createSearchJobRecord, createSearchJobStore } = await import('../search-job-store');
    const store = createSearchJobStore();
    const job = createSearchJobRecord({
      searchId: 'claim-job',
      request: {
        companyType: 'Dentist',
        sourceMode: 'ai',
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
        currentSource: 'AI mode',
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

  it('does not let an in-flight active snapshot overwrite cancellation', async () => {
    const { createSearchJobRecord, createSearchJobStore } = await import('../search-job-store');
    const store = createSearchJobStore();
    const job = createSearchJobRecord({
      searchId: 'cancel-race-job',
      request: {
        companyType: 'Dentist',
        sourceMode: 'gmb',
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
        currentSource: 'Google Places API',
        batchesCompleted: 0,
        estimatedRemaining: 50,
      },
    });

    await store.upsert(job);
    await store.requestCancel('cancel-race-job', 2000);
    await store.upsert({
      ...job,
      status: 'complete',
      updatedAt: 3000,
    });

    const persisted = await store.get('cancel-race-job');
    expect(persisted?.status).toBe('cancelled');
    expect(persisted?.cancelRequested).toBe(true);
    expect(persisted?.progress.currentSource).toBe('Cancelled');
  });
});
