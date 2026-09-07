import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeSearchRequest: vi.fn(),
  recordFeedback: vi.fn(),
}));

vi.mock('../../_lib/search-auth.js', () => ({
  authorizeSearchRequest: mocks.authorizeSearchRequest,
}));

vi.mock('../../_lib/vercel-search-service.js', () => ({
  getVercelSearchService: vi.fn().mockResolvedValue({
    recordFeedback: mocks.recordFeedback,
  }),
}));

import handler from '../[id]/feedback';

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
    end() {
      return response;
    },
  };

  return { response, state };
};

describe('/api/search/[id]/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeSearchRequest.mockResolvedValue({ ownerId: 'owner-a' });
    mocks.recordFeedback.mockResolvedValue({
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dentist in Austin, TX',
        locationLabel: 'Austin, TX',
        status: 'complete',
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
    });
  });

  it('rejects feedback without an authenticated owner', async () => {
    mocks.authorizeSearchRequest.mockResolvedValue({});
    const { response, state } = createResponse();

    await handler(
      { method: 'POST', query: { id: 'search-1' }, body: { leadId: 'lead-1', eventType: 'useful' } },
      response,
    );

    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({ code: expect.any(String) });
    expect(mocks.recordFeedback).not.toHaveBeenCalled();
  });

  it('passes only the bounded feedback payload to the internal service', async () => {
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        query: { id: 'search-1' },
        body: { leadId: 'lead-1', eventType: 'wrong_business', reason: 'Closed listing' },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(mocks.recordFeedback).toHaveBeenCalledWith(
      'search-1',
      { leadId: 'lead-1', eventType: 'wrong_business', reason: 'Closed listing' },
      { ownerId: 'owner-a' },
    );
  });
});
