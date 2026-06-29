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

const stateLocation = {
  mode: 'local' as const,
  label: 'California',
  city: 'California',
  stateCode: 'CA',
  postalCode: undefined,
  lat: 36.7783,
  lon: -119.4179,
  boundingBox: {
    south: 32.5,
    west: -124.4,
    north: 42.0,
    east: -114.1,
  },
  warnings: [],
};

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'lead-1',
  name: 'Northstar Labs',
  mobile: '',
  email: '',
  website: 'https://northstarlabs.ai',
  address: '123 Congress Ave, Austin, TX 78701',
  category: 'Dental Clinics',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 68,
  sourceScore: 95,
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
    expect(snapshot?.leads[0]?.website).toBe('https://northstarlabs.ai/');
    expect(snapshot?.leads[0]?.hasPhone).toBe(true);
    expect(snapshot?.leads[0]?.hasWebsite).toBe(true);
  });

  it('keeps structured email and address data from OSM without crawlers', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([
        makeLead({
          id: 'lead-enrich',
          mobile: '+1 512 555 0101',
          email: 'hello@northstarlabs.ai',
          address: '123 Main St, Austin, TX 78701',
          website: 'https://northstarlabs.ai',
          hasEmail: true,
          hasPhone: true,
          hasWebsite: true,
          verifiedEmail: true,
        }),
      ]),
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
    expect(snapshot?.leads[0]?.address).toContain('Austin, TX');
    expect(snapshot?.meta.progress.foundCount).toBeGreaterThanOrEqual(1);
    expect(snapshot?.meta.status).toBe('complete');
  });

  it('skips a failed regional normalization instead of failing the poll', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'California') return stateLocation;
        if (input === 'CA') {
          throw new Error('Request failed with status code 429');
        }
        return localLocation;
      }),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({
            id: 'lead-state',
            city: 'Sacramento, CA',
            source: 'Google Places',
            address: '1000 Capitol Mall, Sacramento, CA 95814',
          }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-3b',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Cleaning Services',
      city: 'California',
      count: 500,
    });

    const snapshot = await service.getSearch(response.searchId);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leads.length).toBeGreaterThan(0);
    expect(snapshot?.meta.status).toBe('discovering');
    expect(snapshot?.meta.providerWarnings.some((warning) => warning.providerId === 'nominatim')).toBe(true);
  });

  it('completes cleanly when every candidate is filtered out by the location gate', async () => {
    const googleCalls: string[] = [];
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockImplementation(async ({ query, queryVariants = [] }) => {
          googleCalls.push(query, ...queryVariants);
          return [
            makeLead({
              id: `lead-${googleCalls.length}`,
              source: 'Google Places',
              address: '200 Main St, Round Rock, TX 78664',
              city: 'Round Rock, TX',
            }),
            makeLead({
              id: `lead-${googleCalls.length}-2`,
              source: 'Google Maps',
              address: '1000 Commerce St, Dallas, TX 75201',
              city: 'Dallas, TX',
            }),
          ];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-3c',
      now: () => 1000,
    });

    await service.startSearch({
      companyType: 'Medical Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await pollJob(service, 'search-3c', 120);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.foundCount).toBe(0);
    expect(snapshot?.leads).toHaveLength(0);
    expect(googleCalls.length).toBeGreaterThan(1);
  });

  it('keeps Google Maps leads when coordinate evidence proves the Austin location', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([]),
      } as never,
      discoverGoogleMapsLeads: vi.fn().mockResolvedValue([
        makeLead({
          id: 'lead-maps-austin',
          source: 'Google Maps',
          address: '',
          city: '',
          latitude: 30.2672,
          longitude: -97.7431,
          mobile: '+1 512 555 0101',
          website: 'https://austinac.com',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
        }),
        makeLead({
          id: 'lead-maps-out',
          source: 'Google Maps',
          address: '',
          city: '',
          latitude: 32.7767,
          longitude: -96.797,
          mobile: '+1 214 555 0199',
          website: 'https://dallasac.com',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
        }),
      ]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-maps-coords',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await pollJob(service, response.searchId);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.leads[0]?.source).toContain('Google Maps');
    expect(snapshot?.leads[0]?.address ?? '').toBe('');
  });

  it('keeps Austin searches inside Austin even when broader Texas seeds return outliers', async () => {
    const austinLead = makeLead({
      id: 'lead-austin',
      address: '500 Congress Ave, Austin, TX 78701',
      city: 'Austin, TX',
    });
    const dallasLead = makeLead({
      id: 'lead-dallas',
      address: '1000 Commerce St, Dallas, TX 75201',
      city: 'Dallas, TX',
    });
    const houstonLead = makeLead({
      id: 'lead-houston',
      address: '1500 Main St, Houston, TX 77002',
      city: 'Houston, TX',
    });
    const texasStateLocation = {
      mode: 'local' as const,
      label: 'Texas',
      city: 'Texas',
      stateCode: 'TX',
      postalCode: undefined,
      lat: 31.0,
      lon: -99.0,
      boundingBox: {
        south: 25.8,
        west: -106.7,
        north: 36.6,
        east: -93.5,
      },
      warnings: [],
    };

    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'Austin, TX') {
          return localLocation;
        }

        if (input === 'TX' || input === 'Texas') {
          return texasStateLocation;
        }

        return localLocation;
      }),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockImplementation(async ({ location }) => {
          if (location?.label === 'Austin, TX') {
            return [austinLead];
          }

          if (location?.label === 'Texas') {
            return [dallasLead, houstonLead];
          }

          return [];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-austin-strict',
      now: () => 1000,
    });

    await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await pollJob(service, 'search-austin-strict', 120);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.leads[0]?.city).toContain('Austin');
    expect(snapshot?.leads[0]?.address).toContain('Austin, TX');
  });

  it('fans out nationwide searches across multiple state seeds and query variants', async () => {
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
        fetchLeads: vi.fn().mockImplementation(async ({ query, queryVariants = [] }) => {
          googleCalls.push(query, ...queryVariants);
          return [makeLead({ id: `lead-${googleCalls.length}` })];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-4',
      now: () => 1000,
    });

    await service.startSearch({
      companyType: 'Law Firms',
      city: 'USA',
      count: 50,
    });

    const snapshot = await pollJob(service, 'search-4', 35);

    expect(googleCalls.length).toBeGreaterThan(1);
    expect(snapshot?.meta.locationLabel).toBe('United States');
    expect(snapshot?.meta.progress.foundCount).toBeGreaterThanOrEqual(1);
  });

  it('completes when structured sources are exhausted even if the target is not met', async () => {
    const googleCalls: string[] = [];
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockImplementation(async ({ query, queryVariants = [] }) => {
          googleCalls.push(query, ...queryVariants);
          return [makeLead({ id: `lead-${googleCalls.length}` })];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-5',
      now: () => 1000,
    });

    await service.startSearch({
      companyType: 'Medical Clinics',
      city: 'Miami, FL',
      count: 50,
    });

    const snapshot = await pollJob(service, 'search-5', 70);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.foundCount).toBeGreaterThan(0);
    expect(googleCalls.length).toBeGreaterThan(1);
  });

  it('stops a no-progress discovery after the 20-second stall window expires', async () => {
    let currentTime = 0;
    const googleCalls: string[] = [];

    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(nationwideLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockImplementation(async ({ query }) => {
          googleCalls.push(query);
          return [];
        }),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-stalled',
      now: () => currentTime,
    });

    const started = await service.startSearch({
      companyType: 'Law Firms',
      city: 'USA',
      count: 50,
    });

    expect(started.meta.status).toBe('queued');

    currentTime = 5_000;
    let snapshot = await service.getSearch('search-stalled');
    expect(snapshot?.meta.status).toBe('discovering');

    currentTime = 12_000;
    snapshot = await service.getSearch('search-stalled');
    expect(snapshot?.meta.status).toBe('discovering');

    currentTime = 25_000;
    snapshot = await service.getSearch('search-stalled');

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.providerWarnings.some((warning) => warning.providerId === 'discovery-limit')).toBe(true);
    expect(googleCalls.length).toBeGreaterThan(1);
  });
});
