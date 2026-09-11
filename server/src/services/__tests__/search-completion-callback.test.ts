import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchRequestSchema } from '../../../../api/_lib/search-contract';
import { createSearchJobRecord, createSearchJobStore, toSearchResponse } from '../search-job-store';
import { createVercelSearchServiceWithDeps } from '../vercel-search-service';
import {
  createSearchCallbackState,
  deliverSearchCompletionCallback,
  isCallbackDue,
} from '../search-completion-callback';

const request = {
  companyType: 'HVAC contractor',
  sourceMode: 'ai' as const,
  city: 'Austin, TX',
  count: 50,
  phoneRequired: true as const,
};

const progress = {
  discovered: 1,
  enriched: 1,
  totalCandidates: 1,
  requestedCount: 50,
  foundCount: 1,
  duplicatesRemoved: 0,
  currentSource: 'Complete',
  batchesCompleted: 1,
  estimatedRemaining: 49,
};

const localLocation = {
  mode: 'local' as const,
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  postalCode: '78701',
  lat: 30.2672,
  lon: -97.7431,
  boundingBox: { south: 30, west: -98, north: 31, east: -97 },
  warnings: [],
};

const makeJob = async () => {
  const store = createSearchJobStore();
  const job = createSearchJobRecord({
    searchId: 'callback-search',
    request,
    query: 'HVAC contractor in Austin, TX',
    locationLabel: 'Austin, TX',
    locationMode: 'local',
    status: 'complete',
    progress,
    leads: [{
      id: 'lead-1',
      name: 'Austin HVAC',
      mobile: '+15125550101',
      email: '',
      website: 'https://austin-hvac.example.com',
      contactSourceUrl: 'https://austin-hvac.example.com/contact',
      contactEvidence: [{
        field: 'phone' as const,
        value: '+15125550101',
        sourceUrl: 'https://austin-hvac.example.com/contact',
        sourceName: 'Public Website',
        sourceKind: 'business_website' as const,
        association: 'business' as const,
      }],
      address: 'Austin, TX',
      category: 'HVAC contractor',
      city: 'Austin, TX',
      source: 'Public Website',
      confidence: 85,
      hasEmail: false,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: false,
      scrapedAt: '2026-09-08T00:00:00.000Z',
    }],
  });
  job.callback = {
    ...createSearchCallbackState('https://hooks.example.com/lead-finder', 0),
    nextAttemptAt: 0,
  };
  await store.create(job);
  return { store, job: (await store.get(job.searchId))! };
};

describe('search completion callback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('delivers a signed terminal response and exposes only safe callback metadata', async () => {
    vi.stubEnv('LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET', 'test-signing-secret-123');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { store, job } = await makeJob();

    const result = await deliverSearchCompletionCallback({
      job,
      response: toSearchResponse(job),
      store,
      now: () => 1_000,
      fetchImplementation,
    });

    expect(result.callback).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 204,
      deliveredAt: 1_000,
    });
    expect(toSearchResponse(result).meta.callback).toMatchObject({
      configured: true,
      status: 'delivered',
      attempts: 1,
    });
    expect(toSearchResponse(result).meta.callback).not.toHaveProperty('url');

    const [, init] = fetchImplementation.mock.calls[0]!;
    const body = String(init?.body);
    const timestamp = (init?.headers as Record<string, string>)['X-Lead-Finder-Timestamp'];
    const signature = createHmac('sha256', 'test-signing-secret-123')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(JSON.parse(body)).toMatchObject({
      event: 'search.completed',
      searchId: 'callback-search',
      status: 'complete',
    });
    expect((init?.headers as Record<string, string>)['X-Lead-Finder-Signature']).toBe(
      `t=${timestamp},v1=${signature}`,
    );
  });

  it('accepts only public HTTPS callback destinations', () => {
    const base = {
      companyType: 'HVAC contractor',
      location: { mode: 'cityState' as const, city: 'Austin', stateCode: 'TX' },
      count: 50,
      phoneRequired: true as const,
    };

    expect(() => searchRequestSchema.parse({
      ...base,
      callback: { url: 'https://hooks.example.com/lead-finder' },
    })).not.toThrow();
    expect(() => searchRequestSchema.parse({
      ...base,
      callback: { url: 'http://hooks.example.com/lead-finder' },
    })).toThrow();
    expect(() => searchRequestSchema.parse({
      ...base,
      callback: { url: 'https://localhost/lead-finder' },
    })).toThrow();
    expect(() => searchRequestSchema.parse({
      ...base,
      callback: { url: 'https://hooks.example.com/lead-finder?token=secret' },
    })).toThrow();
  });

  it('delivers once when a durable service reaches a terminal state', async () => {
    vi.stubEnv('LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET', 'test-signing-secret-123');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { job } = await makeJob();
    const store = createSearchJobStore();
    const service = createVercelSearchServiceWithDeps({
      store,
      idFactory: () => 'service-callback',
      now: () => 1_000,
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads: vi.fn().mockResolvedValue({
        leads: [job.leads[0]!],
        warnings: [],
        coverage: [],
        aiAssistance: 'disabled',
        researchCandidates: [],
        enrichedCount: 0,
      }),
      callbackFetch: fetchImplementation,
    });

    const started = await service.startSearch(
      { ...request, callback: { url: 'https://hooks.example.com/lead-finder' } },
      { ownerId: 'owner-1' },
    );
    await service.getSearch(started.searchId, { ownerId: 'owner-1' });
    await service.getSearch(started.searchId, { ownerId: 'owner-1' });
    const completed = await service.getSearch(started.searchId, { ownerId: 'owner-1' });
    const replay = await service.getSearch(started.searchId, { ownerId: 'owner-1' });

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.callback).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(replay?.meta.callback).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('persists bounded retry state for a transient callback failure', async () => {
    vi.stubEnv('LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET', 'test-signing-secret-123');
    vi.stubEnv('LEAD_FINDER_CALLBACK_RETRY_BASE_MS', '1000');
    vi.stubEnv('LEAD_FINDER_CALLBACK_MAX_ATTEMPTS', '3');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const { store, job } = await makeJob();

    const result = await deliverSearchCompletionCallback({
      job,
      response: toSearchResponse(job),
      store,
      now: () => 10_000,
      fetchImplementation,
    });

    expect(result.callback).toMatchObject({
      status: 'retrying',
      attempts: 1,
      lastStatusCode: 503,
      nextAttemptAt: 11_000,
    });
    expect(isCallbackDue(result.callback, 10_999)).toBe(false);
    expect(isCallbackDue(result.callback, 11_000)).toBe(true);
  });

  it('stops on non-retryable endpoint errors and records a bounded warning', async () => {
    vi.stubEnv('LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET', 'test-signing-secret-123');
    vi.stubEnv('LEAD_FINDER_CALLBACK_MAX_ATTEMPTS', '5');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const { store, job } = await makeJob();

    const result = await deliverSearchCompletionCallback({
      job,
      response: toSearchResponse(job),
      store,
      now: () => 20_000,
      fetchImplementation,
    });

    expect(result.callback).toMatchObject({ status: 'failed', attempts: 1, lastStatusCode: 400 });
    expect(result.providerWarnings).toEqual([
      expect.objectContaining({ providerId: 'integration-callback' }),
    ]);
  });

  it('does not claim a callback before its retry window', async () => {
    const { store, job } = await makeJob();
    job.callback!.nextAttemptAt = 50_000;
    await store.upsert(job);

    await expect(store.claim(job.searchId, 49_999, 10_000, 'token')).resolves.toBeNull();
    await expect(store.claim(job.searchId, 50_000, 10_000, 'token')).resolves.toMatchObject({
      searchId: job.searchId,
      processingToken: 'token',
    });
  });
});
