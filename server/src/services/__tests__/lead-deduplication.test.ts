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
        publicSocialLinks: [
          { platform: 'Facebook', url: 'https://facebook.com/alpha-dental' },
        ],
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
    expect(leads[0]?.publicSocialLinks).toEqual([
      { platform: 'Facebook', url: 'https://facebook.com/alpha-dental' },
    ]);
  });

  it('flattens repeated source tags when enriched records are merged', () => {
    const leads = deduplicateLeads([
      makeLead({
        id: 'lead-a',
        listingUrl: 'https://linkedin.com/in/alpha-dental',
        source: 'LinkedIn',
      }),
      makeLead({
        id: 'lead-b',
        listingUrl: 'https://linkedin.com/in/alpha-dental',
        source: 'LinkedIn, Public Web, Website Crawl',
        mobile: '5125550101',
        hasPhone: true,
      }),
    ]);

    expect(leads).toHaveLength(1);
    expect(leads[0]?.source).toBe('LinkedIn, Public Web, Website Crawl');
  });

  it('preserves public evidence and contact provenance across duplicate enrichment records', () => {
    const leads = deduplicateLeads([
      makeLead({
        id: 'linkedin-discovery',
        name: 'Alpha Dental',
        listingUrl: 'https://www.linkedin.com/in/alpha-dental',
        source: 'LinkedIn',
        confidence: 70,
        publicEvidence: {
          profileTitle: 'Alpha Dental | Practice Owner',
          profileSnippet: 'Public profile snippet for Alpha Dental.',
          sources: [
            {
              providerName: 'Brave Search',
              profileTitle: 'Alpha Dental | Practice Owner',
              profileSnippet: 'Public profile snippet for Alpha Dental.',
            },
          ],
        },
        matchSignals: {
          queryMatches: 2,
          publicSources: 1,
          publicProviderNames: ['Brave Search'],
          categoryMatched: true,
          roleMatched: true,
          locationMatched: true,
        },
      }),
      makeLead({
        id: 'website-enrichment',
        name: 'Alpha Dental LLC',
        listingUrl: 'https://www.linkedin.com/in/alpha-dental',
        source: 'Public Website Enrichment',
        confidence: 58,
        mobile: '5125550101',
        email: 'hello@alpha-dental.com',
        website: 'https://alpha-dental.com',
        contactSourceUrl: 'https://alpha-dental.com/contact',
        hasPhone: true,
        hasEmail: true,
        hasWebsite: true,
        verifiedPhone: true,
        verifiedEmail: true,
        publicEvidence: {
          profileSnippet: 'Longer public snippet with the business website.',
          sources: [
            {
              providerName: 'Bing',
              profileTitle: 'Alpha Dental official website',
              profileSnippet: 'Longer public snippet with the business website.',
            },
          ],
        },
        matchSignals: {
          queryMatches: 1,
          publicSources: 1,
          publicProviderNames: ['Bing'],
          categoryMatched: true,
          roleMatched: false,
          locationMatched: true,
        },
      }),
    ]);

    expect(leads).toHaveLength(1);
    expect(leads[0]?.email).toBe('hello@alpha-dental.com');
    expect(leads[0]?.mobile).toBe('5125550101');
    expect(leads[0]?.contactSourceUrl).toBe('https://alpha-dental.com/contact');
    expect(leads[0]?.publicEvidence?.profileTitle).toBe('Alpha Dental | Practice Owner');
    expect(leads[0]?.publicEvidence?.profileSnippet).toBe(
      'Longer public snippet with the business website.',
    );
    expect(leads[0]?.publicEvidence?.sources?.map((source) => source.providerName)).toEqual([
      'Brave Search',
      'Bing',
    ]);
    expect(leads[0]?.matchSignals).toMatchObject({
      queryMatches: 2,
      publicSources: 2,
      publicProviderNames: ['Brave Search', 'Bing'],
      categoryMatched: true,
      roleMatched: true,
      locationMatched: true,
    });
  });

  it('keeps different public LinkedIn profiles at the same employer separate', () => {
    const leads = deduplicateLeads([
      makeLead({
        id: 'linkedin-owner',
        name: 'Alicia Stone',
        website: 'https://austin-dental.example',
        listingUrl: 'https://linkedin.com/in/alicia-stone',
      }),
      makeLead({
        id: 'linkedin-manager',
        name: 'Jordan Carter',
        website: 'https://austin-dental.example',
        listingUrl: 'https://linkedin.com/in/jordan-carter',
      }),
    ]);

    expect(leads).toHaveLength(2);
    expect(leads.map((lead) => lead.name)).toEqual(['Alicia Stone', 'Jordan Carter']);
  });
});
