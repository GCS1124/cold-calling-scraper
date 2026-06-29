import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleGetSearch,
  handleStartSearch,
  type SearchService,
} from '../search';

const sampleResponse = {
  searchId: 'search-1',
  leads: [],
  meta: {
    query: 'Dental Clinics in Austin, TX',
    locationLabel: 'Austin, TX',
    status: 'complete' as const,
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
};

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

describe('/api/search handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid timezone code', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        body: {
          companyType: 'Dental Clinics',
          location: {
            mode: 'timezone',
            timeZone: 'AKST',
          },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(search.startSearch).not.toHaveBeenCalled();
    expect(state.body).toMatchObject({
      error: 'Invalid search request',
    });
  });

  it('rejects malformed city and state payloads', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        body: {
          companyType: 'Dental Clinics',
          location: {
            mode: 'cityState',
            city: 'Austin, TX',
            stateCode: 'ZZ',
          },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(search.startSearch).not.toHaveBeenCalled();
    expect(state.body).toMatchObject({
      error: 'Invalid search request',
    });
  });

  it('flattens the public location contract before calling the service layer', async () => {
    const search: SearchService = {
      startSearch: vi.fn().mockResolvedValue(sampleResponse as never),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        body: {
          companyType: 'Dental Clinics',
          location: {
            mode: 'cityState',
            city: 'Austin',
            stateCode: 'TX',
          },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(search.startSearch).toHaveBeenCalledOnce();
    expect(search.startSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 50,
      }),
    );
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: {
        locationLabel: 'Austin, TX',
      },
    });
  });

  it('returns search job snapshots by id', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn().mockResolvedValue(sampleResponse as never),
    };
    const { response, state } = createResponse();

    await handleGetSearch(
      search,
      {
        params: {
          searchId: 'search-1',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(search.getSearch).toHaveBeenCalledWith('search-1');
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: {
        locationLabel: 'Austin, TX',
      },
    });
  });

  it('returns 204 when a search id is valid but no job snapshot is available', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn().mockResolvedValue(null),
    };
    const { response, state } = createResponse();

    await handleGetSearch(
      search,
      {
        params: {
          searchId: 'search-missing',
        },
      },
      response,
    );

    expect(state.statusCode).toBe(204);
    expect(state.ended).toBe(true);
    expect(search.getSearch).toHaveBeenCalledWith('search-missing');
  });

  it('returns 400 when a search id is missing', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleGetSearch(
      search,
      {
        params: {},
      },
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: 'Missing search id' });
  });
});
