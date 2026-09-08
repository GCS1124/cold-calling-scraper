import { describe, expect, it, vi } from 'vitest';

import {
  LeadFinderApiError,
  LeadFinderClient,
  type FetchImplementation,
  type SearchResponse,
} from './index';

const response = (body: unknown, status = 200) =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'request-test' },
  });

const baseRequest = {
  companyType: 'HVAC contractor',
  sourceMode: 'ai' as const,
  location: { mode: 'cityState' as const, city: 'Austin', stateCode: 'TX' },
  count: 50,
  phoneRequired: true as const,
};

const snapshot = (status: SearchResponse['meta']['status'], path: 'durable' | 'stateless'): SearchResponse => ({
  contractVersion: 2,
  searchId: 'search-test',
  leads: [],
  meta: {
    sourceMode: 'ai',
    execution:
      path === 'durable'
        ? {
            path,
            pollable: true,
            resumable: true,
            startedAt: '2026-09-08T00:00:00.000Z',
            lastProgressAt: '2026-09-08T00:00:00.000Z',
          }
        : {
            path,
            pollable: false,
            resumable: false,
            startedAt: '2026-09-08T00:00:00.000Z',
            lastProgressAt: '2026-09-08T00:00:00.000Z',
            completedAt: '2026-09-08T00:00:00.000Z',
          },
    phonePolicy: {
      required: true,
      evidence: 'public_phone_evidence',
      lineType: 'not_checked',
      reachability: 'not_checked',
      personalOwnership: 'not_checked',
      emailDelivery: 'not_checked',
    },
    limitations: [],
    query: 'HVAC contractor in Austin, TX',
    locationLabel: 'Austin, TX',
    status,
    progress: {
      discovered: 0,
      enriched: 0,
      totalCandidates: 0,
      requestedCount: 50,
      foundCount: 0,
      duplicatesRemoved: 0,
      currentSource: '',
      batchesCompleted: 0,
      estimatedRemaining: 0,
    },
    totals: { total: 0, withEmail: 0, withPhone: 0, withWebsite: 0 },
    providerWarnings: [],
  },
});

describe('LeadFinderClient', () => {
  it('sends server-side authentication and an idempotency key without changing phone policy', async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(response(snapshot('complete', 'stateless')));
    const client = new LeadFinderClient({
      baseUrl: 'https://example.test',
      apiKey: 'server-only-key',
      fetch: fetchMock,
    });

    await client.startSearch(baseRequest, { idempotencyKey: 'crm-job-1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/api/v1/search');
    expect((init?.headers as Headers).get('x-api-key')).toBe('server-only-key');
    expect((init?.headers as Headers).get('Idempotency-Key')).toBe('crm-job-1');
    expect(JSON.parse(String(init?.body))).toMatchObject({ phoneRequired: true });
  });

  it('polls durable searches and stops at a terminal response', async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    fetchMock
      .mockResolvedValueOnce(response(snapshot('discovering', 'durable')))
      .mockResolvedValueOnce(response(snapshot('complete', 'durable')));
    const client = new LeadFinderClient({
      baseUrl: 'https://example.test',
      bearerToken: 'token',
      fetch: fetchMock,
    });

    const result = await client.searchUntilTerminal(baseRequest, {
      pollIntervalMs: 100,
      maxWaitMs: 2_000,
    });

    expect(result.meta.status).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/search/search-test');
  });

  it('does not poll stateless responses', async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(response(snapshot('complete', 'stateless')));
    const client = new LeadFinderClient({ baseUrl: 'https://example.test', fetch: fetchMock });

    const result = await client.searchUntilTerminal(baseRequest);

    expect(result.meta.execution?.pollable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns machine-readable API errors into a typed error', async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      response(
        {
          error: 'Rate limited',
          code: 'INTEGRATION_RATE_LIMITED',
          retryable: true,
          requestId: 'request-429',
          contractVersion: 1,
        },
        429,
      ),
    );
    const client = new LeadFinderClient({ baseUrl: 'https://example.test', fetch: fetchMock });

    await expect(client.getCapabilities()).rejects.toMatchObject<Partial<LeadFinderApiError>>({
      status: 429,
      code: 'INTEGRATION_RATE_LIMITED',
      retryable: true,
      requestId: 'request-429',
    });
  });

  it('discovers the machine-readable OpenAPI document from the existing capabilities route', async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      response({ openapi: '3.1.0', paths: { '/api/v1/search': { post: {} } } }),
    );
    const client = new LeadFinderClient({ baseUrl: 'https://example.test', fetch: fetchMock });

    const document = await client.getOpenApi();

    expect(document.openapi).toBe('3.1.0');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://example.test/api/v1/capabilities?format=openapi',
    );
  });
});
