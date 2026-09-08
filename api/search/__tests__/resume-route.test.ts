import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitUntil } from '@vercel/functions';
import { authorizeSearchRequest } from '../../../api/_lib/search-auth.js';

const mocks = vi.hoisted(() => ({
  resumeSearch: vi.fn(),
  advanceSearch: vi.fn(),
}));

vi.mock('../../../api/_lib/search-auth.js', () => ({
  authorizeSearchRequest: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../api/_lib/vercel-search-service.js', () => ({
  getVercelSearchService: vi.fn().mockResolvedValue({
    resumeSearch: mocks.resumeSearch,
    advanceSearch: mocks.advanceSearch,
  }),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

import handler from '../[id]/resume';

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

describe('/api/search/[id]/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeSearchRequest).mockResolvedValue({});
    mocks.resumeSearch.mockResolvedValue({
      searchId: 'search-1',
      leads: [],
      meta: {
        status: 'discovering',
        progress: {},
      },
    });
    mocks.advanceSearch.mockReturnValue(new Promise(() => {}));
  });

  it('keeps resume advancement inside the authenticated owner boundary', async () => {
    vi.mocked(authorizeSearchRequest).mockResolvedValue({ ownerId: 'owner-a' });
    const { response, state } = createResponse();

    await handler(
      {
        method: 'POST',
        query: { id: 'search-1' },
      },
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(mocks.resumeSearch).toHaveBeenCalledWith('search-1', { ownerId: 'owner-a' });
    expect(mocks.advanceSearch).toHaveBeenCalledWith('search-1', 'owner-a');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
