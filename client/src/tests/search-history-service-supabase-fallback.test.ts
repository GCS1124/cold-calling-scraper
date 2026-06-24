import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => {
    const table = {
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({
              data: null,
              error: { message: 'missing table' },
            }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { message: 'missing table' },
          }),
        }),
      }),
    };

    return {
      from: () => table,
    };
  },
}));

import { loadSearchHistory, rememberSearchHistory } from '../services/search-history-service';

describe('search-history-service supabase fallback', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('falls back to local history when the supabase table is unavailable', async () => {
    const saved = await rememberSearchHistory(
      {
        companyType: 'Roofing Contractors',
        location: {
          mode: 'cityState',
          city: 'Austin',
          stateCode: 'TX',
        },
        count: 50,
      },
      {
        userId: 'user-1',
        leads: [
          {
            id: 'lead-1',
            name: 'Roof Right Now',
            category: 'Roofing Contractors',
            city: 'Austin, TX',
            source: 'Google Places',
            confidence: 90,
            hasEmail: true,
            hasPhone: true,
            hasWebsite: true,
            verifiedPhone: true,
            verifiedEmail: true,
            scrapedAt: '2026-04-21T00:00:00.000Z',
          },
        ] as never,
      },
    );

    expect(saved.companyType).toBe('Roofing Contractors');
    expect(saved.city).toBe('Austin, TX');
    expect(saved.locationLabel).toBe('Austin, TX');
    expect(saved.leadCount).toBe(1);

    const items = await loadSearchHistory('user-1');

    expect(items).toHaveLength(1);
    expect(items[0]?.companyType).toBe('Roofing Contractors');
    expect(items[0]?.city).toBe('Austin, TX');
    expect(items[0]?.leadCount).toBe(1);
  });
});
