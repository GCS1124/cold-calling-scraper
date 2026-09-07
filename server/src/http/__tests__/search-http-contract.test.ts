import { describe, expect, it } from 'vitest';

import {
  getIdempotencyKey,
  getRequestId,
  sendSearchError,
  withSearchRequestId,
} from '../search-http-contract';
import type { SearchResponse } from '../../types/search';

describe('search HTTP contract', () => {
  it('accepts bounded idempotency keys and rejects malformed values', () => {
    expect(getIdempotencyKey({ headers: { 'idempotency-key': 'search-retry-42' } })).toBe(
      'search-retry-42',
    );
    expect(getIdempotencyKey({ headers: { 'Idempotency-Key': 'search-retry-43' } })).toBe(
      'search-retry-43',
    );
    expect(getIdempotencyKey({ headers: {} })).toBeUndefined();
    expect(getIdempotencyKey({ headers: { 'idempotency-key': 'contains spaces' } })).toBeNull();
  });

  it('preserves a bounded caller request id and rejects unsafe values', () => {
    expect(getRequestId({ headers: { 'x-request-id': 'client-search-42' } })).toBe(
      'client-search-42',
    );

    const generated = getRequestId({
      headers: { 'x-request-id': 'contains spaces and is too risky' },
    });
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('emits a machine-readable error while preserving the UI error string', () => {
    const state = {
      status: 0,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
    };
    const response = {
      setHeader(name: string, value: string) {
        state.headers[name] = value;
        return response;
      },
      status(code: number) {
        state.status = code;
        return response;
      },
      json(payload: unknown) {
        state.body = payload;
        return response;
      },
    };

    sendSearchError(response, 503, {
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
      message: 'Search persistence is unavailable.',
      retryable: false,
      requestId: 'request-42',
    });

    expect(state.status).toBe(503);
    expect(state.headers['X-Request-Id']).toBe('request-42');
    expect(state.body).toEqual({
      error: 'Search persistence is unavailable.',
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
      retryable: false,
      requestId: 'request-42',
      contractVersion: 1,
    });
  });

  it('adds request correlation to a search snapshot without changing its payload', () => {
    const response: SearchResponse = {
      searchId: 'search-1',
      leads: [],
      meta: {
        query: 'Dentist in Austin, TX',
        locationLabel: 'Austin, TX',
        status: 'complete' as const,
        progress: {
          discovered: 0,
          enriched: 0,
          totalCandidates: 0,
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

    expect(withSearchRequestId(response, 'request-99').meta.requestId).toBe('request-99');
    expect(response.meta.requestId).toBeUndefined();
  });
});
