import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitUntil } from '@vercel/functions';
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
});
