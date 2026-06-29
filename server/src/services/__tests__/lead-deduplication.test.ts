import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { deduplicateLeads } from '../lead-deduplication';

const makeLead = (overrides: Partial<Lead>): Lead => ({
  id: 'lead-base',
  name: 'Alpha Dental',
  mobile: '',
  email: '',
  website: '',
  address: '123 Congress Ave, Austin, TX 78701',
  category: 'Dental Clinics',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 50,
  sourceScore: 90,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-05-21T00:00:00.000Z',
  ...overrides,
});

describe('deduplicateLeads', () => {
  it('merges transitive duplicate chains across domain and phone keys', () => {
    const leads = deduplicateLeads([
      makeLead({
        id: 'lead-a',
        name: 'Alpha Dental',
        website: 'https://alpha-dental.com',
        source: 'Google Places',
        confidence: 60,
        hasWebsite: true,
      }),
      makeLead({
        id: 'lead-b',
        name: 'Alpha Dental LLC',
        website: 'https://alpha-dental.com',
        mobile: '5125550101',
        source: 'Google Maps',
        confidence: 75,
        hasPhone: true,
        hasWebsite: true,
        verifiedPhone: true,
      }),
      makeLead({
        id: 'lead-c',
        name: 'Alpha Dental Marketing',
        mobile: '5125550101',
        source: 'OpenStreetMap',
        confidence: 68,
        hasPhone: true,
      }),
    ]);

    expect(leads).toHaveLength(1);
    expect(leads[0]?.id).toBe('lead-b');
    expect(leads[0]?.source).toContain('Google Places');
    expect(leads[0]?.source).toContain('Google Maps');
    expect(leads[0]?.source).toContain('OpenStreetMap');
    expect(leads[0]?.mobile).toBe('5125550101');
  });
});
