import { describe, expect, it, vi } from 'vitest';

import { createSearchJobStore } from '../search-job-store';
import { createVercelSearchServiceWithDeps } from '../vercel-search-service';
import type { Lead } from '../../types/lead';
import { googlePlacesProvider } from '../../providers/google-places';

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

const timezoneLocation = {
  mode: 'timezone' as const,
  label: 'Eastern Time',
  city: 'Eastern Time',
  stateCode: '',
  timeZoneCode: 'ET' as const,
  postalCode: undefined,
  lat: 39.8283,
  lon: -98.5795,
  boundingBox: {
    south: 24.3963,
    west: -92.0,
    north: 47.4597,
    east: -66.9346,
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

  it('caps the persisted completed result at the requested count', async () => {
    const candidates = Array.from({ length: 75 }, (_, index) =>
      makeLead({
        id: `lead-${index + 1}`,
        name: `Northstar Labs ${index + 1}`,
        mobile: `512555${String(1000 + index)}`,
        website: `https://northstar-${index + 1}.example.com`,
        address: `${100 + index} Congress Ave, Austin, TX 78701`,
      }),
    );
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue(candidates),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-count-cap',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });
    const snapshot = await pollJob(service, response.searchId, 2);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads).toHaveLength(50);
    expect(snapshot?.meta.progress.foundCount).toBe(50);
  });

  it('filters persisted results to validated public-phone leads', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({
            id: 'phone-ready',
            name: 'Phone Ready Dental',
            mobile: '+1 512 555 0102',
            website: 'https://phone-ready-dental.example',
            hasPhone: true,
            verifiedPhone: true,
          }),
          makeLead({
            id: 'phone-missing',
            name: 'Phone Missing Dental',
            mobile: '',
            website: 'https://phone-missing-dental.example',
            hasPhone: false,
            verifiedPhone: false,
          }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-vercel-phone-required',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
      phoneRequired: true,
    });
    const snapshot = await pollJob(service, response.searchId, 20);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.leads[0]?.name).toBe('Phone Ready Dental');
    expect(snapshot?.meta.providerWarnings).toContainEqual(
      expect.objectContaining({
        providerId: 'phone-required',
        message: expect.stringContaining('Excluded 1 lead'),
      }),
    );
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
    expect(snapshot?.leads[0]?.website).toBe('https://northstarlabs.ai');
    expect(snapshot?.leads[0]?.hasPhone).toBe(true);
    expect(snapshot?.leads[0]?.hasWebsite).toBe(true);
  });

  it('treats an unconfigured Google Places key as an informational free fallback', async () => {
    const previousApiKey = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;

    try {
      const service = createVercelSearchServiceWithDeps({
        store: createSearchJobStore(),
        normalizeLocation: vi.fn().mockResolvedValue(localLocation),
        googlePlaces: googlePlacesProvider,
        discoverOsmLeads: vi.fn().mockResolvedValue([
          makeLead({
            id: 'free-fallback-lead',
            source: 'OpenStreetMap',
          }),
        ]),
        discoverGoogleMapsLeads: vi.fn().mockResolvedValue([]),
        idFactory: () => 'search-free-fallback',
        now: () => 1000,
      });

      const started = await service.startSearch({
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 50,
      });
      const snapshot = await pollJob(service, started.searchId);

      expect(snapshot?.meta.status).toBe('complete');
      expect(snapshot?.leads[0]?.source).toContain('OpenStreetMap');
      expect(snapshot?.meta.providerWarnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: 'google-places',
            severity: 'info',
            message: expect.stringContaining('free OpenStreetMap'),
          }),
        ]),
      );
      expect(snapshot?.meta.providerWarnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'GOOGLE_PLACES_API_KEY is not configured',
          }),
        ]),
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.GOOGLE_PLACES_API_KEY;
      } else {
        process.env.GOOGLE_PLACES_API_KEY = previousApiKey;
      }
    }
  });

  it('completes a LinkedIn search with public profile listings', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverLinkedinLeads: vi.fn().mockResolvedValue({
        leads: [
          makeLead({
            id: 'linkedin-lead-1',
            name: 'Mark Sweeney',
            source: 'LinkedIn',
            website: '',
            listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
            hasWebsite: true,
            sourceScore: 82,
          }),
        ],
        warnings: [],
        blocked: false,
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-1',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const snapshot = await service.getSearch(response.searchId);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.currentSource).toBe('Complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.leads[0]?.listingUrl).toContain('/in/');
    expect(snapshot?.meta.providerWarnings).toHaveLength(0);
  });

  it('returns the durable in-progress snapshot for overlapping LinkedIn polls', async () => {
    let markDiscoveryStarted = () => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery = (_result: {
      leads: Lead[];
      warnings: [];
      blocked: boolean;
    }) => {};
    const discoveryResult = new Promise<{
      leads: Lead[];
      warnings: [];
      blocked: boolean;
    }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discoverLinkedinLeads = vi.fn().mockImplementation(async () => {
      markDiscoveryStarted();
      return discoveryResult;
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverLinkedinLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-overlap',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const firstPoll = service.getSearch(response.searchId);
    await discoveryStarted;

    const overlappingSnapshot = await service.getSearch(response.searchId);

    expect(overlappingSnapshot?.meta.status).toBe('discovering');
    expect(overlappingSnapshot?.meta.progress.currentSource).toBe('LinkedIn');
    expect(discoverLinkedinLeads).toHaveBeenCalledOnce();

    releaseDiscovery({ leads: [], warnings: [], blocked: false });
    const completedSnapshot = await firstPoll;

    expect(completedSnapshot?.meta.status).toBe('complete');
    expect(completedSnapshot?.leads).toHaveLength(0);
  });

  it('does not duplicate LinkedIn discovery across service instances', async () => {
    const store = createSearchJobStore();
    let markDiscoveryStarted = () => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery = (_result: {
      leads: Lead[];
      warnings: [];
      blocked: boolean;
    }) => {};
    const discoveryResult = new Promise<{
      leads: Lead[];
      warnings: [];
      blocked: boolean;
    }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discoverLinkedinLeads = vi.fn().mockImplementation(async () => {
      markDiscoveryStarted();
      return discoveryResult;
    });
    const createService = () =>
      createVercelSearchServiceWithDeps({
        store,
        normalizeLocation: vi.fn().mockResolvedValue(localLocation),
        discoverLinkedinLeads,
        discoverOsmLeads: vi.fn().mockResolvedValue([]),
        now: () => 1000,
      });
    const first = createService();
    const second = createService();

    const response = await first.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const firstAdvance = first.advanceSearch(response.searchId);
    await discoveryStarted;

    const secondSnapshot = await second.advanceSearch(response.searchId);

    expect(secondSnapshot?.meta.status).toBe('discovering');
    expect(discoverLinkedinLeads).toHaveBeenCalledOnce();

    releaseDiscovery({ leads: [], warnings: [], blocked: false });
    const completedSnapshot = await firstAdvance;

    expect(completedSnapshot?.meta.status).toBe('complete');
  });

  it('persists public LinkedIn contact enrichment in the Vercel search job', async () => {
    const enrichLinkedinLeads = vi.fn().mockImplementation(async ({ leads }) => ({
      leads: leads.map((lead: Lead) => ({
        ...lead,
        mobile: '+1 512 555 0199',
        email: 'hello@markdental.com',
        website: 'https://markdental.com',
        hasEmail: true,
        hasPhone: true,
        hasWebsite: true,
        verifiedEmail: true,
        verifiedPhone: true,
        source: `${lead.source}, Public Web, Website Crawl`,
      })),
      warnings: [],
      enrichedCount: leads.length,
    }));
    const discoverLinkedinLeads = vi.fn().mockResolvedValue({
      leads: [makeLead({
        id: 'linkedin-enriched-lead',
        name: 'Mark Sweeney',
        source: 'LinkedIn',
        website: '',
        listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
      })],
      warnings: [],
      blocked: false,
    });

    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverLinkedinLeads,
      enrichLinkedinLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-enriched',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const discoveringSnapshot = await service.getSearch(response.searchId);
    expect(discoveringSnapshot?.meta.status).toBe('enriching');
    const snapshot = await service.getSearch(response.searchId);

    expect(discoverLinkedinLeads).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 31_000 }),
    );
    expect(enrichLinkedinLeads).toHaveBeenCalledTimes(1);
    expect(enrichLinkedinLeads).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 25_000 }),
    );
    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads[0]?.email).toBe('hello@markdental.com');
    expect(snapshot?.leads[0]?.mobile).toBe('+1 512 555 0199');
    expect(snapshot?.leads[0]?.website).toBe('https://markdental.com');
    expect(snapshot?.leads[0]?.source).toContain('Website Crawl');
    expect(snapshot?.meta.progress.duplicatesRemoved).toBe(0);
  });

  it('resumes public LinkedIn contact enrichment in durable batches', async () => {
    const leads = Array.from({ length: 14 }, (_, index) =>
      makeLead({
        id: `linkedin-batch-${index}`,
        name: `Mark Sweeney ${index}`,
        source: 'LinkedIn',
        website: '',
        listingUrl: `https://linkedin.com/in/mark-sweeney-${index}`,
      }),
    );
    const enrichmentBatchSizes: number[] = [];
    const enrichLinkedinLeads = vi.fn().mockImplementation(
      async ({ leads: batch, onProgress }) => {
        enrichmentBatchSizes.push(batch.length);
        onProgress?.(batch.length);

        return {
          leads: batch.map((lead: Lead) => ({
            ...lead,
            mobile: `+1 512 555 ${String(1900 + Number(lead.id.split('-').pop())).padStart(4, '0')}`,
            email: `hello-${lead.id}@markdental.com`,
            website: `https://markdental-${lead.id}.com`,
            hasEmail: true,
            hasPhone: true,
            hasWebsite: true,
            verifiedEmail: true,
            verifiedPhone: true,
            source: `${lead.source}, Public Web, Website Crawl`,
          })),
          warnings: [],
          enrichedCount: batch.length,
        };
      },
    );
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverLinkedinLeads: vi.fn().mockResolvedValue({
        leads,
        warnings: [],
        blocked: false,
      }),
      enrichLinkedinLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-batches',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const discoveringSnapshot = await service.getSearch(response.searchId);
    expect(discoveringSnapshot?.meta.status).toBe('enriching');
    expect(discoveringSnapshot?.meta.progress.enriched).toBe(0);

    const firstBatchSnapshot = await service.getSearch(response.searchId);
    expect(firstBatchSnapshot?.meta.status).toBe('enriching');
    expect(firstBatchSnapshot?.meta.progress.enriched).toBe(12);
    expect(enrichmentBatchSizes).toEqual([12]);

    const completedSnapshot = await service.getSearch(response.searchId);
    expect(completedSnapshot?.meta.status).toBe('complete');
    expect(completedSnapshot?.meta.progress.enriched).toBe(14);
    expect(enrichmentBatchSizes).toEqual([12, 2]);
    expect(completedSnapshot?.leads).toHaveLength(14);
    expect(completedSnapshot?.leads.every((lead) => lead.hasEmail && lead.hasPhone)).toBe(true);
  });

  it('completes LinkedIn searches gracefully when public profile pages are blocked', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverLinkedinLeads: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [
          {
            providerId: 'linkedin-search-brave',
            providerName: 'Brave Search',
            message: 'Brave Search returned a blocked or rate-limited page while searching public LinkedIn profiles.',
          },
        ],
        blocked: true,
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-blocked',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Founder',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'linkedin',
    });

    const snapshot = await service.getSearch(response.searchId);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.currentSource).toBe('Complete');
    expect(snapshot?.leads).toHaveLength(0);
    expect(snapshot?.meta.providerWarnings.some((warning) => warning.providerName === 'Brave Search')).toBe(true);
    expect(snapshot?.meta.providerWarnings.some((warning) => warning.providerName === 'LinkedIn')).toBe(true);
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

  it('persists a failed Google Maps fallback across service instances', async () => {
    const discoverGoogleMapsLeads = vi.fn().mockRejectedValue(
      new Error('page.goto: net::ERR_INSUFFICIENT_RESOURCES at https://www.google.com/maps/...'),
    );
    const store = createSearchJobStore();
    const createService = () =>
      createVercelSearchServiceWithDeps({
        store,
        normalizeLocation: vi.fn().mockResolvedValue(localLocation),
        googlePlaces: {
          id: 'google-places',
          name: 'Google Places',
          fetchLeads: vi.fn().mockResolvedValue([
            makeLead({
              id: 'lead-existing-after-maps-failure',
              name: 'Existing HVAC Result',
            }),
          ]),
        } as never,
        discoverGoogleMapsLeads,
        discoverOsmLeads: vi.fn().mockResolvedValue([]),
        now: () => 1000,
      });

    const first = createService();
    const response = await first.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Austin, TX',
      count: 50,
    });

    await first.getSearch(response.searchId);
    expect((await store.get(response.searchId))?.googleMapsUnavailable).toBe(true);

    const second = createService();
    await second.getSearch(response.searchId);

    expect(discoverGoogleMapsLeads).toHaveBeenCalledTimes(1);
  });

  it('keeps timezone Google Maps leads when coordinates fall inside the timezone boundary', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'Eastern Time') {
          return timezoneLocation;
        }

        return localLocation;
      }),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([]),
      } as never,
      discoverGoogleMapsLeads: vi.fn().mockResolvedValue([
        makeLead({
          id: 'lead-maps-timezone',
          source: 'Google Maps',
          address: '',
          city: 'New York, NY',
          latitude: 40.7128,
          longitude: -74.006,
          mobile: '+1 212 555 0101',
          website: 'https://newyorkhvac.com',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
        }),
      ]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-maps-timezone',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Eastern Time',
      count: 50,
    });

    const snapshot = await pollJob(service, response.searchId);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.leads[0]?.source).toContain('Google Maps');
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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

  it('stops a no-progress discovery after the 45-second stall window expires', async () => {
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

    currentTime = 50_000;
    snapshot = await service.getSearch('search-stalled');

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.providerWarnings.some((warning) => warning.providerId === 'discovery-limit')).toBe(true);
    expect(googleCalls.length).toBeGreaterThan(1);
  });

  it('runs free AI mode without calling the GMB discovery providers', async () => {
    const googleFetchLeads = vi.fn().mockResolvedValue([makeLead({ id: 'gmb-should-not-run' })]);
    const googlePlaces = {
      id: 'google-places',
      name: 'Google Places',
      fetchLeads: googleFetchLeads,
    } as never;
    const discoverOsmLeads = vi.fn().mockResolvedValue([makeLead({ id: 'osm-should-not-run' })]);
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [
        makeLead({
          id: 'ai-public-1',
          source: 'LinkedIn, Public Profile',
        }),
      ],
      warnings: [
        {
          providerId: 'ai-mode-policy',
          providerName: 'AI mode',
          message: 'Free-only public discovery.',
        },
      ],
      coverage: [
        {
          providerId: 'apollo-audit',
          providerName: 'Apollo',
          status: 'not_configured' as const,
          leadCount: 0,
          message: 'Not used in free mode.',
        },
        {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'returned' as const,
          leadCount: 1,
        },
      ],
      aiAssistance: 'disabled' as const,
      enrichedCount: 0,
      publicCoverage: {
        queriesAttempted: 10,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 1,
        queryFamilies: ['role-led'],
      },
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces,
      discoverOsmLeads,
      discoverAiLeads,
      idFactory: () => 'search-ai-mode',
      now: () => 1000,
    });

    const started = await service.startSearch({
      companyType: 'HVAC contractor',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });
    const snapshot = await service.getSearch(started.searchId);

    expect(discoverAiLeads).toHaveBeenCalledTimes(1);
    expect(googleFetchLeads).not.toHaveBeenCalled();
    expect(discoverOsmLeads).not.toHaveBeenCalled();
    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.providerCoverage?.[0]?.providerName).toBe('Apollo');
    expect(snapshot?.meta.progress.publicQueriesAttempted).toBe(10);
    expect(snapshot?.leads[0]?.source).toContain('LinkedIn');
  });
});
