import { describe, expect, it } from 'vitest';

import {
  createSearchRequestFingerprint,
  isValidIdempotencyKey,
  normalizeIdempotencyKey,
  SearchIdempotencyConflictError,
} from '../search-idempotency';

const baseRequest = {
  companyType: 'Dentist',
  sourceMode: 'gmb' as const,
  researchDepth: 'verified' as const,
  city: 'Austin, TX',
  count: 50,
  phoneRequired: true as const,
};

describe('search idempotency', () => {
  it('normalizes bounded keys without accepting header injection characters', () => {
    expect(normalizeIdempotencyKey('  search-42  ')).toBe('search-42');
    expect(isValidIdempotencyKey('search-42')).toBe(true);
    expect(normalizeIdempotencyKey('search 42')).toBeUndefined();
    expect(normalizeIdempotencyKey('x'.repeat(129))).toBeUndefined();
  });

  it('fingerprints equivalent normalized requests identically', () => {
    const first = createSearchRequestFingerprint({
      ...baseRequest,
      companyType: '  Dentist  ',
      city: 'Austin,   TX',
      filters: { sources: [' Google Places ', 'Google Places'] },
    });
    const second = createSearchRequestFingerprint({
      ...baseRequest,
      filters: { sources: ['Google Places'] },
    });

    expect(first).toBe(second);
    expect(createSearchRequestFingerprint({ ...baseRequest, count: 100 })).not.toBe(first);
  });

  it('exposes a stable conflict error for key reuse with changed criteria', () => {
    const error = new SearchIdempotencyConflictError();

    expect(error).toMatchObject({
      name: 'SearchIdempotencyConflictError',
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: expect.stringContaining('different search request'),
    });
  });
});
