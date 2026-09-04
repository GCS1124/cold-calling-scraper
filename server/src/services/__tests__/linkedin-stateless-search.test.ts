import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import type { SearchRequest } from '../../types/search';

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

vi.mock('../osm-discovery', () => ({
  discoverUsLeadsFromOsm: mocks.listings,
}));

vi.mock('../us-location', () => ({
  normalizeUsLocation: mocks.normalize,
}));

import {
  createStatelessLinkedinSearch,
  runStatelessLinkedinSearch,
} from '../linkedin-stateless-search';

const location = {
  mode: 'local' as const,
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  warnings: [],
};

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'linkedin-austin-dentist',
  name: 'Jordan Lee',
  headline: 'Owner at Austin Dental',
  mobile: '',
  email: '',
  website: '',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin',
  source: 'LinkedIn, Public Profile',
  confidence: 88,
  sourceScore: 86,
  listingUrl: 'https://linkedin.com/in/jordan-lee',
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

const request: SearchRequest = {
  companyType: 'Dentist',
  sourceMode: 'linkedin',
  city: 'Austin, TX',
  count: 50,
};

describe('runStatelessLinkedinSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalize.mockResolvedValue(location);
    mocks.discover.mockResolvedValue({
      leads: [makeLead()],
      warnings: [],
      blocked: false,
    });
    mocks.listings.mockResolvedValue([]);
    mocks.enrich.mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
      leads: leads.map((lead) =>
        makeLead({
          ...lead,
          email: 'hello@austindental.example',
          mobile: '+1 512 555 0100',
          website: 'https://austindental.example',
          hasEmail: true,
          hasPhone: true,
          hasWebsite: true,
          verifiedEmail: true,
          verifiedPhone: true,
          source: `${lead.source}, Public Web, Website Crawl`,
        }),
      ),
      warnings: [],
      enrichedCount: leads.length,
    }));
  });

  it('returns public LinkedIn leads with public website contact enrichment', async () => {
    const response = await runStatelessLinkedinSearch(request);

    expect(response.meta.status).toBe('complete');
    expect(response.meta.locationLabel).toBe('Austin, TX');
    expect(response.meta.progress).toMatchObject({
      discovered: 1,
      enriched: 1,
      foundCount: 1,
      currentSource: 'Complete',
      requestedCount: 50,
    });
    expect(response.leads[0]).toMatchObject({
      email: 'hello@austindental.example',
      mobile: '+1 512 555 0100',
      website: 'https://austindental.example',
      source: 'LinkedIn, Public Profile, Public Web, Website Crawl',
    });
    expect(response.leads[0]?.listingUrl).toBe('https://linkedin.com/in/jordan-lee');
    expect(mocks.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        location,
        deadlineMs: expect.any(Number),
      }),
    );
    expect(mocks.enrich).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        location,
        deadlineMs: expect.any(Number),
      }),
    );
  });

  it('returns only validated public-phone leads when the phone requirement is enabled', async () => {
    const leadWithoutPhone = makeLead({
      id: 'linkedin-without-phone',
      name: 'No Phone Practice',
      listingUrl: 'https://linkedin.com/in/no-phone-practice',
    });
    const leadWithPhone = makeLead({
      id: 'linkedin-with-phone',
      name: 'Phone Ready Practice',
      listingUrl: 'https://linkedin.com/in/phone-ready-practice',
    });
    mocks.discover.mockResolvedValue({
      leads: [leadWithoutPhone, leadWithPhone],
      warnings: [],
      blocked: false,
    });
    mocks.enrich.mockResolvedValue({
      leads: [
        makeLead({
          ...leadWithoutPhone,
          mobile: '',
          hasPhone: false,
          verifiedPhone: false,
        }),
        makeLead({
          ...leadWithPhone,
          mobile: '+1 512 555 0110',
          website: 'https://phone-ready.example',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
          source: 'LinkedIn, Public Profile, Public Web, Website Crawl',
        }),
      ],
      warnings: [],
      enrichedCount: 2,
    });

    const response = await runStatelessLinkedinSearch({
      ...request,
      phoneRequired: true,
    });

    expect(response.leads).toHaveLength(1);
    expect(response.leads[0]?.name).toBe('Phone Ready Practice');
    expect(response.meta.totals.withPhone).toBe(1);
    expect(response.meta.providerWarnings).toContainEqual(
      expect.objectContaining({
        providerId: 'phone-required',
        message: expect.stringContaining('Excluded 1 lead'),
      }),
    );
  });

  it('bridges a matching free listing phone into a LinkedIn owner profile', async () => {
    const owner = makeLead({
      id: 'linkedin-owner',
      name: 'Avery Smith',
      headline: 'Owner at Austin Dental Studio',
      website: 'https://austindental.example',
      listingUrl: 'https://linkedin.com/in/avery-smith',
    });
    const listing = makeLead({
      id: 'osm-owner-business',
      name: 'Austin Dental Studio',
      headline: '',
      source: 'OpenStreetMap',
      listingUrl: 'https://www.openstreetmap.org/node/456',
      website: 'https://austindental.example',
      mobile: '+1 512 555 0199',
      hasPhone: true,
      verifiedPhone: true,
    });
    const search = createStatelessLinkedinSearch({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [owner],
        warnings: [],
        blocked: false,
      }),
      discoverPublicListings: vi.fn().mockResolvedValue([listing]),
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: leads.length,
      })),
      normalizeLocation: vi.fn().mockResolvedValue(location),
    });

    const response = await search({
      ...request,
      phoneRequired: true,
    });

    expect(response.meta.status).toBe('complete');
    expect(response.leads).toHaveLength(1);
    expect(response.leads[0]).toMatchObject({
      id: 'linkedin-owner',
      mobile: '+1 512 555 0199',
      contactSourceUrl: 'https://www.openstreetmap.org/node/456',
    });
    expect(response.leads[0]?.listingUrl).toBe('https://linkedin.com/in/avery-smith');
    expect(response.leads[0]?.source).toContain('OpenStreetMap');
  });

  it('returns a truthful failed response when location normalization fails', async () => {
    mocks.normalize.mockRejectedValue(new Error('No US location match found'));

    const response = await runStatelessLinkedinSearch(request);

    expect(response.meta.status).toBe('failed');
    expect(response.leads).toHaveLength(0);
    expect(response.meta.providerWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'location-normalizer',
          message: 'No US location match found',
        }),
        expect.objectContaining({
          providerId: 'no-usable-results',
          severity: 'error',
        }),
      ]),
    );
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.enrich).not.toHaveBeenCalled();
  });
});
