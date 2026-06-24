import { afterEach, describe, expect, it } from 'vitest';

import { loadSearchHistory, rememberSearchHistory } from '../services/search-history-service';

describe('search-history-service', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('stores and restores local fallback history when signed out', async () => {
    const saved = await rememberSearchHistory({
      companyType: 'Dental Clinics',
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    }, {
      leads: [
        {
          id: 'lead-1',
          name: 'Northstar Labs',
          category: 'Dental Clinics',
          city: 'Austin, TX',
          source: 'Google Places',
          confidence: 92,
          hasEmail: true,
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
          verifiedEmail: true,
          scrapedAt: '2026-04-21T00:00:00.000Z',
        },
      ] as never,
    });

    expect(saved.companyType).toBe('Dental Clinics');
    expect(saved.city).toBe('EST');
    expect(saved.locationLabel).toBe('Eastern Time');
    expect(saved.leadCount).toBe(1);

    const items = await loadSearchHistory();

    expect(items).toHaveLength(1);
    expect(items[0].companyType).toBe('Dental Clinics');
    expect(items[0].city).toBe('EST');
    expect(items[0].leadCount).toBe(1);
    expect(items[0].leads).toHaveLength(1);
  });
});
