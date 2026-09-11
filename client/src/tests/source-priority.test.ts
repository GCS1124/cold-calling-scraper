import { describe, expect, it } from 'vitest';

import type { Lead, ProviderCoverage } from '../types/lead';
import {
  comparePublicSourcePriority,
  getPublicSourcePriority,
  isNotaryRelatedCategory,
  sortProviderCoverageForDisplay,
} from '../utils/source-priority';

const baseLead: Lead = {
  id: 'source-priority-lead',
  name: 'Public lead',
  category: 'Notary',
  city: 'Austin, TX',
  source: 'Public LinkedIn',
  listingUrl: 'https://www.linkedin.com/in/public-lead',
  confidence: 90,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: false,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-09-10T00:00:00.000Z',
};

describe('AI public source priority', () => {
  it('orders indexed NotaryCafe, pure LinkedIn, generic public evidence, then fusion', () => {
    const notary = {
      ...baseLead,
      id: 'notary',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: 'https://notarycafe.com/Public.Notary',
    };
    const fusion = {
      ...baseLead,
      id: 'fusion',
      source: 'Public LinkedIn, Google Places',
      listingUrl: 'https://www.google.com/maps/search/?api=1&query=Public%20Lead',
    };

    expect(getPublicSourcePriority(notary)).toBe(1);
    expect(getPublicSourcePriority(baseLead)).toBe(2);
    expect(getPublicSourcePriority(fusion)).toBe(4);
    expect(comparePublicSourcePriority(notary, baseLead)).toBeLessThan(0);
    expect(comparePublicSourcePriority(baseLead, fusion)).toBeLessThan(0);
  });

  it('detects fusion from merged evidence even when the source label was normalized', () => {
    const fusedAfterMerge = {
      ...baseLead,
      source: 'Public Profile',
      listingUrl: 'https://www.linkedin.com/in/public-lead',
      contactSourceUrl: 'https://www.google.com/maps/place/public-lead',
      publicEvidence: {
        sources: [{ providerName: 'Google Business (GMB) listings' }],
      },
    };
    const businessOnly = {
      ...baseLead,
      source: 'Google Places',
      listingUrl: 'https://www.google.com/maps/place/business-only',
      contactSourceUrl: undefined,
    };

    expect(getPublicSourcePriority(fusedAfterMerge)).toBe(4);
    expect(getPublicSourcePriority(businessOnly)).toBe(3);
  });

  it('recognizes notary-related request language without widening unrelated categories', () => {
    expect(isNotaryRelatedCategory('mobile notary')).toBe(true);
    expect(isNotaryRelatedCategory('loan signing agent')).toBe(true);
    expect(isNotaryRelatedCategory('HVAC contractor')).toBe(false);
  });

  it('keeps high-priority coverage cards ahead of audit-only providers', () => {
    const coverage = [
      { providerId: 'apollo-audit', providerName: 'Apollo', status: 'not_configured', leadCount: 0 },
      { providerId: 'gemini-public-discovery', providerName: 'Gemini', status: 'returned', leadCount: 1 },
      { providerId: 'notarycafe-indexed-search', providerName: 'NotaryCafe, Indexed Public Search', status: 'returned', leadCount: 2 },
      { providerId: 'linkedin-public-search', providerName: 'Public LinkedIn Search', status: 'returned', leadCount: 3 },
      { providerId: 'linkedin-public-google-business-fusion', providerName: 'LinkedIn + Google Business fusion', status: 'returned', leadCount: 1 },
      { providerId: 'google-places-ai', providerName: 'Google Business (GMB) listings', status: 'configured', leadCount: 0 },
    ] satisfies ProviderCoverage[];

    expect(sortProviderCoverageForDisplay(coverage).map((provider) => provider.providerId)).toEqual([
      'notarycafe-indexed-search',
      'linkedin-public-search',
      'gemini-public-discovery',
      'google-places-ai',
      'linkedin-public-google-business-fusion',
      'apollo-audit',
    ]);
  });
});
