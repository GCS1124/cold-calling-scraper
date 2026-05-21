import { afterEach, describe, expect, it } from 'vitest';

import { loadSearchHistory, rememberSearchHistory } from '../services/search-history-service';

describe('search-history-service', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('stores and restores local fallback history when signed out', async () => {
    const saved = await rememberSearchHistory({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    expect(saved.companyType).toBe('Dental Clinics');
    expect(saved.city).toBe('Austin, TX');

    const items = await loadSearchHistory();

    expect(items).toHaveLength(1);
    expect(items[0].companyType).toBe('Dental Clinics');
    expect(items[0].city).toBe('Austin, TX');
  });
});
