import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitUntil } from '@vercel/functions';
import { getSearchJobSnapshot } from '../../../server/src/services/search-job-snapshot.js';
import { vercelSearchService } from '../../../server/src/services/vercel-search-service.js';
import { getVercelSearchService } from '../../../api/_lib/vercel-search-service.js';

vi.mock('../../../server/src/services/search-job-snapshot.js', () => ({
  getSearchJobSnapshot: vi.fn(),
}));

vi.mock('../../../api/_lib/vercel-search-service.js', () => ({
  getVercelSearchService: vi.fn().mockResolvedValue(vercelSearchService),
}));

vi.mock('../../../server/src/services/vercel-search-service.js', () => ({
  vercelSearchService: {
    getSearchSnapshot: vi.fn(),
    advanceSearch: vi.fn(),
  },
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

import handler from '../[id].ts';

const createResponse = () => {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
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
    end() {
      state.ended = true;
      return response;
    },
  };

  return {
    response,
    state,
  };
};

describe('/api/search/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 204 when the snapshot is no longer available', async () => {
    vi.mocked(getSearchJobSnapshot).mockResolvedValue(null);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'GET',
        query: {
          id: 'search-1',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(204);
    expect(state.ended).toBe(true);
    expect(state.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(getSearchJobSnapshot).toHaveBeenCalledWith('search-1');
  });

  it('returns the stored snapshot when it exists', async () => {
    vi.mocked(getSearchJobSnapshot).mockResolvedValue({
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dental Clinics in Austin, TX',
        locationLabel: 'Austin, TX',
        status: 'complete',
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
    } as never);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'GET',
        query: {
          id: 'search-1',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: {
        locationLabel: 'Austin, TX',
      },
    });
    expect(vercelSearchService.advanceSearch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('returns an in-progress snapshot without waiting for provider work', async () => {
    vi.mocked(getSearchJobSnapshot).mockResolvedValue({
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dentist in Austin, TX',
        locationLabel: 'Austin, TX',
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
        totals: {
          total: 0,
          withEmail: 0,
          withPhone: 0,
          withWebsite: 0,
        },
        providerWarnings: [],
      },
    } as never);
    vi.mocked(vercelSearchService.advanceSearch).mockReturnValue(new Promise(() => {}));
    const { response, state } = createResponse();

    await handler(
      {
        method: 'GET',
        query: {
          id: 'search-1',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: { status: 'discovering' },
    });
    expect(vercelSearchService.advanceSearch).toHaveBeenCalledWith('search-1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns a configuration error when the snapshot store is unavailable', async () => {
    const error = Object.assign(
      new Error('Search persistence is unavailable.'),
      { code: 'SEARCH_PERSISTENCE_UNAVAILABLE' },
    );
    vi.mocked(getSearchJobSnapshot).mockRejectedValue(error);
    const { response, state } = createResponse();

    await handler(
      {
        method: 'GET',
        query: {
          id: 'search-1',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(503);
    expect(state.body).toEqual({
      error: 'Search persistence is unavailable.',
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
    });
  });
});
