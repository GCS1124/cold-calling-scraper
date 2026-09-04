import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  listings: vi.fn(),
  enrich: vi.fn(),
  normalize: vi.fn(),
}));

vi.mock('../linkedin-search', () => ({
  discoverUsLeadsFromLinkedinSearch: mocks.discover,
}));

vi.mock('../linkedin-contact-enrichment', () => ({
  enrichLinkedinLeadsWithPublicContacts: mocks.enrich,
}));

vi.mock('../us-location', () => ({
  normalizeUsLocation: mocks.normalize,
}));

import { runStatelessAiSearch } from '../ai-lead-discovery';
import { createAiLeadDiscovery } from '../ai-lead-discovery';

const location = {
  mode: 'local' as const,
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  lat: 30.2672,
  lon: -97.7431,
  boundingBox: {
    south: 30,
    west: -98,
    north: 31,
    east: -97,
  },
  warnings: [],
};

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'ai-lead',
  name: 'Austin Dental Studio',
  headline: 'Owner at Austin Dental Studio',
  mobile: '',
  email: '',
  website: 'https://austindentalstudio.com',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin',
  source: 'LinkedIn, Public Profile',
  confidence: 88,
  sourceScore: 86,
  listingUrl: 'https://linkedin.com/in/austin-dental',
  hasEmail: false,
  hasPhone: false,
  hasWebsite: true,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-03T00:00:00.000Z',
  ...overrides,
});

describe('runStatelessAiSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalize.mockResolvedValue(location);
    mocks.discover.mockResolvedValue({
      leads: [
        makeLead({
          id: 'ai-no-phone',
          name: 'AI No Phone Dental',
          listingUrl: 'https://linkedin.com/in/ai-no-phone',
          website: 'https://ai-no-phone.example',
        }),
        makeLead({
          id: 'ai-phone',
          name: 'AI Phone Ready Dental',
          listingUrl: 'https://linkedin.com/in/ai-phone',
          website: 'https://ai-phone.example',
        }),
      ],
      warnings: [],
      blocked: false,
    });
    mocks.enrich.mockResolvedValue({
      leads: [
        makeLead({
          id: 'ai-no-phone',
          name: 'AI No Phone Dental',
          listingUrl: 'https://linkedin.com/in/ai-no-phone',
          website: 'https://ai-no-phone.example',
        }),
        makeLead({
          id: 'ai-phone',
          name: 'AI Phone Ready Dental',
          listingUrl: 'https://linkedin.com/in/ai-phone',
          website: 'https://ai-phone.example',
          mobile: '+1 512 555 0120',
          hasPhone: true,
          verifiedPhone: true,
        }),
      ],
      warnings: [],
      enrichedCount: 2,
    });
  });

  it('applies the mandatory public-phone rule after free AI enrichment', async () => {
    const response = await runStatelessAiSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      phoneRequired: true,
    });

    expect(response.leads).toHaveLength(1);
    expect(response.leads[0]?.id).toBe('ai-phone');
    expect(response.meta.totals.withPhone).toBe(1);
    expect(response.meta.providerWarnings).toContainEqual(
      expect.objectContaining({
        providerId: 'phone-required',
        message: expect.stringContaining('Excluded 1 lead'),
      }),
    );
    expect(response.meta.progress.phoneExcludedCount).toBe(1);
  });

  it('fails instead of claiming completion when no public-phone lead survives validation', async () => {
    mocks.discover.mockResolvedValue({ leads: [], warnings: [], blocked: false });

    const response = await runStatelessAiSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      phoneRequired: true,
    });

    expect(response.meta.status).toBe('failed');
    expect(response.meta.progress.currentSource).toBe('Failed');
    expect(response.meta.providerWarnings).toContainEqual(
      expect.objectContaining({
        providerId: 'no-usable-results',
        severity: 'error',
      }),
    );
  });

  it('merges free public business listings with public LinkedIn discovery', async () => {
    mocks.listings.mockResolvedValue([
      makeLead({
        id: 'osm-public-listing',
        name: 'Austin Public Listing',
        source: 'OpenStreetMap',
        listingUrl: 'https://www.openstreetmap.org/node/123',
        mobile: '+1 512 555 0198',
        hasPhone: true,
        verifiedPhone: true,
      }),
    ]);
    mocks.enrich.mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
      leads,
      warnings: [],
      enrichedCount: leads.length,
    }));

    const discovery = createAiLeadDiscovery({
      discoverLinkedin: mocks.discover,
      discoverPublicListings: mocks.listings,
      enrichPublicContacts: mocks.enrich,
    });
    const result = await discovery({
      request: {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
        phoneRequired: true,
      },
      location,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads.map((lead) => lead.id)).toContain('osm-public-listing');
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'public-business-listings',
        status: 'returned',
        leadCount: 1,
      }),
    );
  });

  it('bridges a public listing phone into an unqualified LinkedIn owner lead', async () => {
    const owner = makeLead({
      name: 'Avery Smith',
      headline: 'Owner at Austin Dental Studio',
      mobile: '',
      website: 'https://austindentalstudio.com',
      hasPhone: false,
      verifiedPhone: false,
    });
    const listing = makeLead({
      id: 'osm-owner-business',
      name: 'Austin Dental Studio',
      source: 'OpenStreetMap',
      listingUrl: 'https://www.openstreetmap.org/node/456',
      website: 'https://austindentalstudio.com',
      mobile: '+1 512 555 0199',
      hasPhone: true,
      verifiedPhone: true,
    });
    const discovery = createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [owner],
        warnings: [],
        blocked: false,
      }) as never,
      discoverPublicListings: vi.fn().mockResolvedValue([listing]) as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: leads.length,
      })) as never,
    });

    const result = await discovery({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50, phoneRequired: true },
      location,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toBe('Avery Smith');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
    expect(result.leads[0]?.source).toContain('OpenStreetMap');
    expect(result.leads[0]?.contactSourceUrl).toBe(listing.listingUrl);
  });
});
