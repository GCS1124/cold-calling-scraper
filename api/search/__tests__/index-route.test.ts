import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitUntil } from '@vercel/functions';
import { runStatelessLinkedinSearch } from '../../../server/src/services/linkedin-stateless-search.js';
import { vercelSearchService } from '../../../server/src/services/vercel-search-service.js';

vi.mock('../../../api/_lib/vercel-search-service.js', () => ({
  getVercelSearchService: vi.fn().mockResolvedValue(vercelSearchService),
}));

vi.mock('../../../server/src/services/vercel-search-service.js', () => ({
  vercelSearchService: {
    startSearch: vi.fn(),
    advanceSearch: vi.fn(),
  },
}));

vi.mock('../../../server/src/services/linkedin-stateless-search.js', () => ({
  runStatelessLinkedinSearch: vi.fn(),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

import handler from '../index.ts';

const createResponse = () => {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      state.body = payload;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return response;
    },
  };

  return { response, state };
};

describe('/api/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the queued job immediately and schedules background advancement', async () => {
    vi.mocked(vercelSearchService.startSearch).mockResolvedValue({
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dentist in EST',
        locationLabel: 'EST',
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
        totals: {
          total: 0,
          withEmail: 0,
          withPhone: 0,
          withWebsite: 0,
        },
        providerWarnings: [],
      },
    });
    vi.mocked(vercelSearchService.advanceSearch).mockReturnValue(new Promise(() => {}));
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        body: {
          companyType: 'Dentist',
          sourceMode: 'linkedin',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(state.body).toMatchObject({ searchId: 'search-1', meta: { status: 'queued' } });
    expect(vercelSearchService.startSearch).toHaveBeenCalledWith({
      companyType: 'Dentist',
      sourceMode: 'linkedin',
      city: 'EST',
      count: 50,
      filters: undefined,
    });
    expect(vercelSearchService.advanceSearch).toHaveBeenCalledWith('search-1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns a configuration error when search persistence is unavailable', async () => {
    const error = Object.assign(
      new Error('Search persistence is not configured.'),
      { code: 'SEARCH_PERSISTENCE_UNAVAILABLE' },
    );
    vi.mocked(vercelSearchService.startSearch).mockRejectedValue(error);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        body: {
          companyType: 'Dentist',
          sourceMode: 'gmb',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(503);
    expect(state.body).toEqual({
      error: 'Search persistence is not configured.',
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
    });
  });

  it('returns a completed public LinkedIn response without durable storage', async () => {
    const error = Object.assign(
      new Error('Search persistence is not configured.'),
      { code: 'SEARCH_PERSISTENCE_UNAVAILABLE' },
    );
    const statelessResponse = {
      searchId: 'linkedin-stateless-search',
      leads: [],
      meta: {
        query: 'Dentist in Eastern Time',
        locationLabel: 'Eastern Time',
        status: 'complete' as const,
        progress: {
          discovered: 0,
          enriched: 0,
          totalCandidates: 0,
          requestedCount: 50,
          foundCount: 0,
          duplicatesRemoved: 0,
          currentSource: 'Complete',
          batchesCompleted: 1,
          estimatedRemaining: 50,
        },
        totals: {
          total: 0,
          withEmail: 0,
          withPhone: 0,
          withWebsite: 0,
        },
        providerWarnings: [],
      },
    };
    vi.mocked(vercelSearchService.startSearch).mockRejectedValue(error);
    vi.mocked(runStatelessLinkedinSearch).mockResolvedValue(statelessResponse);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        body: {
          companyType: 'Dentist',
          sourceMode: 'linkedin',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual(statelessResponse);
    expect(runStatelessLinkedinSearch).toHaveBeenCalledWith({
      companyType: 'Dentist',
      sourceMode: 'linkedin',
      city: 'EST',
      count: 50,
      filters: undefined,
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('uses the stateless LinkedIn path before importing the durable job service', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.mocked(runStatelessLinkedinSearch).mockResolvedValue({} as never);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        body: {
          companyType: 'Dentist',
          sourceMode: 'linkedin',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(runStatelessLinkedinSearch).toHaveBeenCalledTimes(1);
    expect(vercelSearchService.startSearch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
