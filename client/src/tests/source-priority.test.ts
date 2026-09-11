import { describe, expect, it } from 'vitest';

import type { Lead, ProviderCoverage } from '../types/lead';
import {
  comparePublicSourcePriority,
  getPublicSourceOrder,
  getPublicSourcePriority,
  isNotaryRelatedCategory,
  publicLeadSourceOrderLabels,
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
  it('orders every public stage before the final fusion stage', () => {
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
    const yelp = {
      ...baseLead,
      id: 'yelp',
      source: 'Yelp, Public Directory',
      listingUrl: 'https://www.yelp.com/biz/public-lead',
      publicSocialLinks: undefined,
    };
    const yellowPages = {
      ...baseLead,
      id: 'yellow-pages',
      source: 'Yellow Pages, Public Directory',
      listingUrl: 'https://www.yellowpages.com/austin-tx/public-lead',
      publicSocialLinks: undefined,
    };
    const gemini = {
      ...baseLead,
      id: 'gemini',
      source: 'Gemini, Grounded Public Search',
      listingUrl: 'https://gemini-public.example/public-lead',
      publicSocialLinks: undefined,
    };
    const googlePlaces = {
      ...baseLead,
      id: 'google-places',
      source: 'Google Places',
      listingUrl: 'https://www.google.com/maps/place/public-lead',
      publicSocialLinks: undefined,
    };

    expect(getPublicSourcePriority(notary)).toBe(1);
    expect(getPublicSourcePriority(baseLead)).toBe(2);
    expect(getPublicSourceOrder(notary)).toBe(1);
    expect(getPublicSourceOrder(baseLead)).toBe(2);
    expect(getPublicSourceOrder(yelp)).toBe(3);
    expect(getPublicSourceOrder(yellowPages)).toBe(4);
    expect(getPublicSourceOrder(gemini)).toBe(5);
    expect(getPublicSourceOrder(googlePlaces)).toBe(6);
    expect(getPublicSourcePriority(fusion)).toBe(4);
    expect(getPublicSourceOrder(fusion)).toBe(7);
    expect(comparePublicSourcePriority(notary, baseLead)).toBeLessThan(0);
    expect(comparePublicSourcePriority(googlePlaces, fusion)).toBeLessThan(0);
    expect(publicLeadSourceOrderLabels[7]).toContain('fusion');
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
    expect(getPublicSourceOrder(fusedAfterMerge)).toBe(7);
    expect(getPublicSourceOrder(businessOnly)).toBe(6);
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
      { providerId: 'yelp-public-directory', providerName: 'Yelp, Public Directory', status: 'returned', leadCount: 1 },
      { providerId: 'yellow-pages-public-directory', providerName: 'Yellow Pages, Public Directory', status: 'returned', leadCount: 1 },
      { providerId: 'linkedin-public-google-business-fusion', providerName: 'LinkedIn + Google Business fusion', status: 'returned', leadCount: 1 },
      { providerId: 'public-business-listings', providerName: 'Public Business Listings', status: 'configured', leadCount: 0 },
      { providerId: 'google-places-ai', providerName: 'Google Business (GMB) listings', status: 'configured', leadCount: 0 },
    ] satisfies ProviderCoverage[];

    expect(sortProviderCoverageForDisplay(coverage).map((provider) => provider.providerId)).toEqual([
      'notarycafe-indexed-search',
      'linkedin-public-search',
      'yelp-public-directory',
      'yellow-pages-public-directory',
      'gemini-public-discovery',
      'public-business-listings',
      'google-places-ai',
      'linkedin-public-google-business-fusion',
      'apollo-audit',
    ]);
  });
});
