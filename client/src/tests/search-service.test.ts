import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchApiError, searchApi } from '../services/search-service';

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
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        location: {
          mode: 'timezone',
          timeZone: 'EST',
        },
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

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/search/search-1',
      expect.objectContaining({
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns null when the search snapshot is no longer available', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
    } as unknown as Response);

    await expect(searchApi.getSearch('search-1')).resolves.toBeNull();
  });

  it('recovers from a transient gateway timeout while polling a search', async () => {
    vi.useFakeTimers();
    const json = vi.fn().mockResolvedValue(successfulPayload);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        json: vi.fn().mockResolvedValue({ error: 'Gateway timeout' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json,
      } as unknown as Response);

    try {
      const pending = searchApi.getSearch('search-1');
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual(successfulPayload);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a hanging snapshot request and keeps the failure retryable', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    try {
      const pending = searchApi.getSearch('search-1');
      await vi.runAllTimersAsync();

      await expect(pending).rejects.toMatchObject({ retryable: true });
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry permanent snapshot errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: 'Not found' }),
    } as unknown as Response);

    await expect(searchApi.getSearch('missing-search')).rejects.toThrow('Not found');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('marks exhausted gateway failures as retryable for background polling', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      json: vi.fn().mockResolvedValue({ error: 'Gateway timeout' }),
    } as unknown as Response);

    try {
      const pending = searchApi.getSearch('search-1');
      await vi.runAllTimersAsync();

      await expect(pending).rejects.toBeInstanceOf(SearchApiError);
      await expect(pending).rejects.toMatchObject({ retryable: true });
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces an API error without falling back to localhost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Not found' }),
    } as unknown as Response);

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        location: {
          mode: 'timezone',
          timeZone: 'EST',
        },
        count: 50,
      }),
    ).rejects.toThrow('Not found');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyType: 'Dental Clinics',
        location: {
          mode: 'timezone',
          timeZone: 'EST',
        },
        count: 50,
      }),
    });
  });

  it('surfaces a helpful error when the API is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        sourceMode: 'linkedin',
        location: {
          mode: 'timezone',
          timeZone: 'EST',
        },
        count: 50,
      }),
    ).rejects.toThrow('Unable to reach LinkedIn public-profile search. Please try again.');
  });

  it('replaces legacy generic API errors with a source-aware message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Failed to fetch US lead results' }),
    } as unknown as Response);

    await expect(
      searchApi.startSearch({
        companyType: 'HVAC Contractors',
        sourceMode: 'linkedin',
        location: {
          mode: 'cityState',
          city: 'Austin',
          stateCode: 'TX',
        },
        count: 50,
      }),
    ).rejects.toThrow('Unable to reach LinkedIn public-profile search. Please try again.');
  });

  it('uses a safe message when an API error is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    await expect(
      searchApi.startSearch({
        companyType: 'Dental Clinics',
        location: {
          mode: 'timezone',
          timeZone: 'EST',
        },
        count: 50,
      }),
    ).rejects.toThrow('Unable to reach the lead search service. Please try again.');
  });
});
