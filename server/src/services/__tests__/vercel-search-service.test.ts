import { describe, expect, it, vi } from 'vitest';

import { createSearchJobStore } from '../search-job-store';
import { createVercelSearchServiceWithDeps } from '../vercel-search-service';
import type { Lead } from '../../types/lead';

const nationwideLocation = {
  mode: 'nationwide' as const,
  label: 'United States',
  city: '',
  stateCode: '',
  postalCode: undefined,
  lat: 39.8283,
  lon: -98.5795,
  boundingBox: {
    south: 24.3963,
    west: -125,
    north: 49.3845,
    east: -66.9346,
  },
  warnings: [],
};

const localLocation = {
  mode: 'local' as const,
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  postalCode: '78701',
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
  id: 'lead-1',
  name: 'Northstar Labs',
  mobile: '',
  email: '',
  website: 'https://northstarlabs.ai',
  address: '',
  category: 'Dental Clinics',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 68,
  sourceScore: 95,
  qualified: false,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-05-21T00:00:00.000Z',
  ...overrides,
});

describe('createVercelSearchServiceWithDeps', () => {
  const pollJob = async (
    service: ReturnType<typeof createVercelSearchServiceWithDeps>,
    searchId: string,
    iterations = 60,
  ) => {
    let snapshot: Awaited<ReturnType<typeof service.getSearch>> = null;
    for (let index = 0; index < iterations; index += 1) {
      snapshot = await service.getSearch(searchId);
    }
    return snapshot;
  };

  it('persists a job across service instances', async () => {
    const store = createSearchJobStore();
    const googleCalls: string[] = [];
    const googlePlaces = {
      id: 'google-places',
      name: 'Google Places',
      fetchLeads: vi.fn().mockImplementation(async ({ query }) => {
        googleCalls.push(query);
        return [makeLead({ id: `lead-${googleCalls.length}` })];
      }),
    } as never;

    const first = createVercelSearchServiceWithDeps({
      store,
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'USA') return nationwideLocation;
        return localLocation;
      }),
      googlePlaces,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead: vi.fn().mockImplementation(async (lead: Lead) => ({
        lead: {
          ...lead,
          email: 'hello@northstarlabs.ai',
          qualified: true,
          hasEmail: true,
          verifiedEmail: true,
          source: `${lead.source}, Website Crawl`,
        },
        warnings: [],
      })),
      idFactory: () => 'search-1',
      now: () => 1000,
    });

    const started = await first.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    expect(started.searchId).toBe('search-1');
    expect(started.meta.query).toBe('Dental Clinics in Austin, TX');
    expect(started.meta.status).toBe('queued');

    const second = createVercelSearchServiceWithDeps({
      store,
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'USA') return nationwideLocation;
        return localLocation;
      }),
      googlePlaces,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead: vi.fn().mockImplementation(async (lead: Lead) => ({
        lead: {
          ...lead,
          email: 'hello@northstarlabs.ai',
          qualified: true,
          hasEmail: true,
          verifiedEmail: true,
          source: `${lead.source}, Website Crawl`,
        },
        warnings: [],
      })),
      now: () => 2000,
    });

    const snapshot = await second.getSearch('search-1');

    expect(snapshot?.searchId).toBe('search-1');
    expect(snapshot?.meta.locationLabel).toBe('Austin, TX');
    expect(snapshot?.leads.length).toBeGreaterThan(0);
  });

  it('returns phone and website data directly from the Google-first path', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({
            mobile: '+1 512 555 0101',
            website: 'northstarlabs.ai',
            hasPhone: true,
            hasWebsite: true,
            verifiedPhone: true,
          }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead: vi.fn().mockResolvedValue({
        lead: makeLead({
          mobile: '+1 512 555 0101',
          hasPhone: true,
          verifiedPhone: true,
        }),
        warnings: [],
      }),
      idFactory: () => 'search-2',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await service.getSearch(response.searchId);

    expect(snapshot?.leads[0]?.mobile).toBe('+1 512 555 0101');
    expect(snapshot?.leads[0]?.website).toBe('https://northstarlabs.ai');
    expect(snapshot?.leads[0]?.hasPhone).toBe(true);
    expect(snapshot?.leads[0]?.hasWebsite).toBe(true);
  });

  it('enriches only missing email fields and keeps the job moving', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({
            id: 'lead-enrich',
            mobile: '+1 512 555 0101',
            email: '',
            website: 'northstarlabs.ai',
            hasEmail: false,
            hasPhone: true,
            hasWebsite: true,
            verifiedPhone: true,
            verifiedEmail: false,
          }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead: vi.fn().mockResolvedValue({
        lead: makeLead({
          id: 'lead-enrich',
          mobile: '+1 512 555 0101',
          email: 'hello@northstarlabs.ai',
          website: 'https://northstarlabs.ai',
          hasEmail: true,
          hasPhone: true,
          hasWebsite: true,
          qualified: true,
          verifiedEmail: true,
        }),
        warnings: [],
      }),
      idFactory: () => 'search-3',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await pollJob(service, response.searchId);

    expect(snapshot?.leads[0]?.email).toBe('hello@northstarlabs.ai');
    expect(snapshot?.leads[0]?.qualified).toBe(true);
    expect(snapshot?.meta.progress.qualifiedCount).toBeGreaterThanOrEqual(1);
  });

  it('fans out nationwide searches across multiple state seeds', async () => {
    const googleCalls: string[] = [];
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'USA') return nationwideLocation;
        return localLocation;
      }),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockImplementation(async ({ query }) => {
          googleCalls.push(query);
          return [makeLead({ id: `lead-${googleCalls.length}` })];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead: vi.fn(),
      idFactory: () => 'search-4',
      now: () => 1000,
    });

    await service.startSearch({
      companyType: 'Law Firms',
      city: 'USA',
      count: 50,
    });

    await service.getSearch('search-4');
    await service.getSearch('search-4');

    expect(googleCalls.length).toBeGreaterThan(1);
  });

  it('does not retry blocked website crawls or surface them in the response', async () => {
    const enrichWebsiteLead = vi
      .fn()
      .mockResolvedValue({
        lead: makeLead({
          id: 'lead-blocked',
          website: 'condoblackbook.com',
          mobile: '',
          email: '',
          hasEmail: false,
          hasPhone: false,
          hasWebsite: true,
          verifiedEmail: false,
          rejectionReason: 'blocked_website',
        }),
        warnings: [
          {
            providerId: 'website-crawl',
            providerName: 'Website Crawl',
            message: 'condoblackbook.com blocked contact crawling at https://condoblackbook.com/',
          },
        ],
      });

    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({
            id: 'lead-blocked',
            website: 'condoblackbook.com',
            mobile: '',
            email: '',
            hasEmail: false,
            hasPhone: false,
            hasWebsite: true,
            verifiedEmail: false,
          }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead,
      idFactory: () => 'search-5',
      now: () => 1000,
    });

    const started = await service.startSearch({
      companyType: 'Medical Clinics',
      city: 'Miami, FL',
      count: 50,
    });

    const first = await pollJob(service, started.searchId, 60);
    const second = await service.getSearch(started.searchId);

    expect(enrichWebsiteLead).toHaveBeenCalledTimes(1);
    expect(first?.meta.providerWarnings).toEqual([]);
    expect(second?.meta.providerWarnings).toEqual([]);
  });
});
