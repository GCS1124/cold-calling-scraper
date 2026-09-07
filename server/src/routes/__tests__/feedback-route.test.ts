import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRecordFeedback, type SearchService } from '../search';

const authMock = vi.hoisted(() => ({
  authenticateSearchRequest: vi.fn(),
}));

vi.mock('../../auth/search-auth', () => ({
  authenticateSearchRequest: authMock.authenticateSearchRequest,
  isSearchAuthorizationError: () => false,
}));

const createResponse = () => {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
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
      return response;
    },
  };

  return { response, state };
};

describe('lead feedback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.authenticateSearchRequest.mockResolvedValue({ ownerId: 'owner-a' });
  });

  it('requires a signed-in owner before accepting feedback', async () => {
    authMock.authenticateSearchRequest.mockResolvedValue({});
    const search = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      recordFeedback: vi.fn(),
    } satisfies SearchService;
    const { response, state } = createResponse();

    await handleRecordFeedback(
      search,
      { params: { searchId: 'search-1' }, body: { leadId: 'lead-1', eventType: 'useful' } },
      response,
    );

    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({ code: 'FEEDBACK_AUTH_REQUIRED' });
    expect(search.recordFeedback).not.toHaveBeenCalled();
  });

  it('validates the event and passes only lead identity to the service', async () => {
    const result = {
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dentist in Austin, TX',
        locationLabel: 'Austin, TX',
        status: 'complete' as const,
        progress: {
          discovered: 1,
          enriched: 1,
          totalCandidates: 1,
          requestedCount: 50,
          foundCount: 0,
          duplicatesRemoved: 0,
          currentSource: 'Complete',
          batchesCompleted: 1,
          estimatedRemaining: 50,
        },
        totals: { total: 0, withEmail: 0, withPhone: 0, withWebsite: 0 },
        providerWarnings: [],
      },
    };
    const recordFeedback = vi.fn().mockResolvedValue(result);
    const search = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      recordFeedback,
    } satisfies SearchService;
    const { response, state } = createResponse();

    await handleRecordFeedback(
      search,
      {
        params: { searchId: 'search-1' },
        body: { leadId: 'lead-1', eventType: 'wrong_phone', reason: 'Listing is stale' },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(recordFeedback).toHaveBeenCalledWith(
      'search-1',
      { leadId: 'lead-1', eventType: 'wrong_phone', reason: 'Listing is stale' },
      { ownerId: 'owner-a' },
    );
  });

  it('rejects unsupported feedback events', async () => {
    const search = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
      recordFeedback: vi.fn(),
    } satisfies SearchService;
    const { response, state } = createResponse();

    await handleRecordFeedback(
      search,
      { params: { searchId: 'search-1' }, body: { leadId: 'lead-1', eventType: 'exported' } },
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'INVALID_FEEDBACK' });
    expect(search.recordFeedback).not.toHaveBeenCalled();
  });
});
