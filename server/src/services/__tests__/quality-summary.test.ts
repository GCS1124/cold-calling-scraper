import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { buildLeadQualitySummary } from '../quality-summary';

const baseLead: Lead = {
  id: 'phone-ready-lead',
  name: 'Austin Dental',
  mobile: '+1 512 555 0100',
  email: '',
  website: 'https://austin-dental.example',
  contactSourceUrl: 'https://austin-dental.example/contact',
  contactEvidence: [
    {
      field: 'phone',
      value: '+15125550100',
      sourceUrl: 'https://austin-dental.example/contact',
      sourceName: 'Public website',
      sourceKind: 'business_website',
      association: 'business',
      observedAt: new Date().toISOString(),
    },
    {
      field: 'phone',
      value: '+15125550100',
      sourceUrl: 'https://www.google.com/maps/place/Austin+Dental',
      sourceName: 'Google Business listing',
      sourceKind: 'business_listing',
      association: 'business',
      observedAt: new Date().toISOString(),
    },
  ],
  category: 'Dentist',
  city: 'Austin',
  source: 'Google Places, Website Crawl',
  confidence: 90,
  sourceScore: 90,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: new Date().toISOString(),
};

describe('buildLeadQualitySummary', () => {
  it('summarizes only phone-qualified leads and preserves independent source families', () => {
    const summary = buildLeadQualitySummary([
      baseLead,
      {
        ...baseLead,
        id: 'phone-missing-lead',
        name: 'Phone Missing Dental',
        mobile: '',
        contactSourceUrl: undefined,
        contactEvidence: [],
        hasPhone: false,
        verifiedPhone: false,
      },
    ]);

    expect(summary.eligible).toBe(1);
    expect(summary.needsReview).toBe(0);
    expect(summary.freshPhoneObservations).toBe(1);
    expect(summary.tierCounts.corroborated).toBe(1);
    expect(summary.sourceFamilyLeadCounts.public_website).toBe(1);
    expect(summary.sourceFamilyLeadCounts.business_listing).toBe(1);
  });
});
