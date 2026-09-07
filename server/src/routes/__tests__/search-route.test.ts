import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleCancelSearch,
  handleGetSearch,
  handleGetEvidence,
  handleReverifySearch,
  handleResumeSearch,
  handleStartSearch,
  type SearchService,
} from '../search';
import { SearchIdempotencyConflictError } from '../../services/search-idempotency';

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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed before parsing a search when auth is required and missing', async () => {
    vi.stubEnv('LEAD_FINDER_AUTH_REQUIRED', 'true');
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        body: {
          companyType: 'Dentist',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({
      code: 'AUTH_REQUIRED',
      retryable: false,
    });
    expect(search.startSearch).not.toHaveBeenCalled();
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

  it('rejects a malformed Idempotency-Key before starting discovery', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        headers: { 'idempotency-key': 'contains spaces' },
        body: {
          companyType: 'Dental Clinics',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(search.startSearch).not.toHaveBeenCalled();
    expect(state.body).toMatchObject({
      error: 'Invalid Idempotency-Key header',
      code: 'INVALID_IDEMPOTENCY_KEY',
      retryable: false,
    });
  });

  it('returns a stable conflict when a key is reused with different criteria', async () => {
    const search: SearchService = {
      startSearch: vi.fn().mockRejectedValue(new SearchIdempotencyConflictError()),
      getSearch: vi.fn(),
    };
    const { response, state } = createResponse();

    await handleStartSearch(
      search,
      {
        headers: { 'idempotency-key': 'search-retry-1' },
        body: {
          companyType: 'Dental Clinics',
          location: { mode: 'timezone', timeZone: 'EST' },
          count: 50,
        },
      },
      response,
    );

    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      retryable: false,
      requestId: expect.any(String),
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
        phoneRequired: true,
      }),
    );
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      meta: {
        locationLabel: 'Austin, TX',
      },
    });
  });

  it('rejects attempts to disable the required public phone field', async () => {
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
            city: 'Austin',
            stateCode: 'TX',
          },
          count: 50,
          phoneRequired: false,
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
    expect(state.body).toMatchObject({
      error: 'Missing search id',
      code: 'MISSING_SEARCH_ID',
      retryable: false,
      contractVersion: 1,
      requestId: expect.any(String),
    });
  });

  it('cancels an active search through the route contract', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      cancelSearch: vi.fn().mockResolvedValue({
        ...sampleResponse,
        meta: { ...sampleResponse.meta, status: 'cancelled' },
      } as never),
    };
    const { response, state } = createResponse();

    await handleCancelSearch(
      search,
      { params: { searchId: 'search-1' } },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(search.cancelSearch).toHaveBeenCalledWith('search-1');
    expect(state.body).toMatchObject({ meta: { status: 'cancelled' } });
  });

  it('returns a clear not-found response when cancellation misses a job', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      cancelSearch: vi.fn().mockResolvedValue(null),
    };
    const { response, state } = createResponse();

    await handleCancelSearch(
      search,
      { params: { searchId: 'missing-search' } },
      response,
    );

    expect(state.statusCode).toBe(404);
    expect(state.body).toMatchObject({
      error: 'Search not found',
      code: 'SEARCH_NOT_FOUND',
      retryable: false,
      contractVersion: 1,
      requestId: expect.any(String),
    });
  });

  it('resumes a cancelled search through the route contract', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      resumeSearch: vi.fn().mockResolvedValue({
        ...sampleResponse,
        meta: { ...sampleResponse.meta, status: 'discovering' },
      } as never),
    };
    const { response, state } = createResponse();

    await handleResumeSearch(
      search,
      { params: { searchId: 'search-1' } },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(search.resumeSearch).toHaveBeenCalledWith('search-1');
    expect(state.body).toMatchObject({ meta: { status: 'discovering' } });
  });

  it('reverifies a stored search through the route contract', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      reverifySearch: vi.fn().mockResolvedValue(sampleResponse as never),
    };
    const { response, state } = createResponse();

    await handleReverifySearch(search, { params: { searchId: 'search-1' } }, response);

    expect(state.statusCode).toBe(200);
    expect(search.reverifySearch).toHaveBeenCalledWith('search-1');
  });

  it('returns source evidence for a stored search', async () => {
    const search: SearchService = {
      startSearch: vi.fn(),
      getSearch: vi.fn().mockResolvedValue(sampleResponse as never),
    };
    const { response, state } = createResponse();

    await handleGetEvidence(
      search,
      { params: { searchId: 'search-1' }, query: {} },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      searchId: 'search-1',
      leads: [],
      limitations: expect.any(Array),
    });
  });
});
