import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchApi } from '../services/search-service';

const originalFetch = globalThis.fetch;

const successfulPayload = {
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
      qualifiedCount: 0,
      discardedCount: 0,
      blockedCount: 0,
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

describe('searchApi', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts to the same-origin search route by default', async () => {
    const json = vi.fn().mockResolvedValue(successfulPayload);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json,
    } as unknown as Response);

    await searchApi.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 50,
      }),
    });
  });

  it('polls a search by id', async () => {
    const json = vi.fn().mockResolvedValue(successfulPayload);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json,
    } as unknown as Response);

    await searchApi.getSearch('search-1');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search/search-1', undefined);
  });

  it('falls back to the local API server when the current dev origin does not proxy /api', async () => {
    const json = vi.fn().mockResolvedValue(successfulPayload);

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'Not found' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json,
      } as unknown as Response);

    await searchApi.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 50,
      }),
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4000/api/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyType: 'Dental Clinics',
          city: 'Austin',
          count: 50,
        }),
      },
    );
  });

  it('surfaces a helpful error when the API is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 50,
      }),
    ).rejects.toThrow(
      'Lead Finder API is not reachable in dev. Start the app with `npm run dev` from the repo root.',
    );
  });
});
