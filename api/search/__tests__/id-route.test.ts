import { beforeEach, describe, expect, it, vi } from 'vitest';

import { vercelSearchService } from '../../../server/src/services/vercel-search-service.js';

vi.mock('../../../server/src/services/vercel-search-service.js', () => ({
  vercelSearchService: {
    getSearch: vi.fn(),
  },
}));

import handler from '../[id].ts';

const createResponse = () => {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
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
    vi.mocked(vercelSearchService.getSearch).mockResolvedValue(null);
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
    expect(vercelSearchService.getSearch).toHaveBeenCalledWith('search-1');
  });

  it('returns the stored snapshot when it exists', async () => {
    vi.mocked(vercelSearchService.getSearch).mockResolvedValue({
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
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: {
        locationLabel: 'Austin, TX',
      },
    });
  });
});
