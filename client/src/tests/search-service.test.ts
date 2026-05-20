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
        requestedCount: 200,
        qualifiedCount: 0,
        discardedCount: 0,
        blockedCount: 0,
        duplicatesRemoved: 0,
        currentSource: 'Queued',
        batchesCompleted: 0,
        estimatedRemaining: 200,
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
      count: 200,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 200,
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

  it('surfaces an API error without falling back to localhost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Not found' }),
    } as unknown as Response);

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 200,
      }),
    ).rejects.toThrow('Not found');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 200,
      }),
    });
  });

  it('surfaces a helpful error when the API is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        city: 'Austin',
        count: 200,
      }),
    ).rejects.toThrow('Failed to fetch');
  });
});
