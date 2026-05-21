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
        city: 'California',
        count: 50,
      },
      { userId: 'user-1', locationLabel: 'California' },
    );

    expect(saved.companyType).toBe('Roofing Contractors');
    expect(saved.city).toBe('California');

    const items = await loadSearchHistory('user-1');

    expect(items).toHaveLength(1);
    expect(items[0]?.companyType).toBe('Roofing Contractors');
    expect(items[0]?.city).toBe('California');
  });
});
