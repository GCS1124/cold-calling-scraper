import { describe, expect, it, vi } from 'vitest';

import { createSearchJobStore } from '../search-job-store';
import { createVercelSearchServiceWithDeps } from '../vercel-search-service';
import type { AiDiscoveryResult } from '../ai-lead-discovery';
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
  mobile: '+1 512 555 0101',
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
  listingUrl: 'https://www.google.com/maps/search/?api=1&query=Northstar+Labs',
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

  it('replays a durable start for the same key without creating a second job', async () => {
    const idFactory = vi.fn()
      .mockReturnValueOnce('idempotent-search-1')
      .mockReturnValueOnce('idempotent-search-2');
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory,
      now: () => 1000,
    });
    const request = {
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    } as const;

    const first = await service.startSearch(request, { idempotencyKey: 'retry-1' });
    const replay = await service.startSearch(request, { idempotencyKey: 'retry-1' });

    expect(replay.searchId).toBe(first.searchId);
    expect(idFactory).toHaveBeenCalledOnce();
    await expect(
      service.startSearch({ ...request, count: 100 }, { idempotencyKey: 'retry-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('does not let one owner advance another owner\'s durable job', async () => {
    const store = createSearchJobStore();
    const service = createVercelSearchServiceWithDeps({
      store,
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'owner-isolated-search',
      now: () => 1000,
    });

    const started = await service.startSearch(
      {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
        sourceMode: 'ai',
      },
      { ownerId: 'owner-a' },
    );

    await expect(service.advanceSearch(started.searchId, 'owner-b')).resolves.toBeNull();
    await expect(store.get(started.searchId, 'owner-a')).resolves.toMatchObject({
      status: 'queued',
      ownerId: 'owner-a',
    });
  });

  it('caps the persisted completed result at the requested count', async () => {
    const candidates = Array.from({ length: 75 }, (_, index) =>
      makeLead({
        id: `lead-${index + 1}`,
        name: `Northstar Labs ${index + 1}`,
        mobile: `512555${String(1000 + index)}`,
        website: `https://northstar-${index + 1}.example.com`,
        listingUrl: `https://www.google.com/maps/search/?api=1&query=Northstar+Labs+${index + 1}`,
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
            listingUrl: 'https://www.google.com/maps/search/?api=1&query=Phone+Ready+Dental',
            hasPhone: true,
            verifiedPhone: true,
          }),
          makeLead({
            id: 'phone-missing',
            name: 'Phone Missing Dental',
            mobile: '',
            website: 'https://phone-missing-dental.example',
            listingUrl: 'https://www.google.com/maps/search/?api=1&query=Phone+Missing+Dental',
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
    const discoverOsmLeads = vi.fn().mockResolvedValue([]);
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
      discoverOsmLeads,
      idFactory: () => 'search-2',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });

    const snapshot = await pollJob(service, response.searchId, 3);

    expect(snapshot?.leads[0]?.mobile).toBe('+1 512 555 0101');
    expect(snapshot?.leads[0]?.website).toBe('https://northstarlabs.ai');
    expect(snapshot?.leads[0]?.hasPhone).toBe(true);
    expect(snapshot?.leads[0]?.hasWebsite).toBe(true);
    expect(discoverOsmLeads).toHaveBeenCalled();
  });

  it('persists public directory coverage in the durable GMB path', async () => {
    const discoverPublicDirectories = vi.fn().mockResolvedValue({
      leads: [makeLead({
        id: 'durable-yelp-lead',
        name: 'Durable Yelp Dental',
        source: 'Yelp',
        listingUrl: 'https://www.yelp.com/biz/durable-yelp-dental',
        contactSourceUrl: 'https://www.yelp.com/biz/durable-yelp-dental',
      })],
      warnings: [],
      coverage: [
        {
          providerId: 'yelp-public-directory',
          providerName: 'Yelp, Public Directory',
          status: 'returned' as const,
          leadCount: 1,
        },
        {
          providerId: 'yellow-pages-public-directory',
          providerName: 'Yellow Pages, Public Directory',
          status: 'returned' as const,
          leadCount: 0,
        },
      ],
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      discoverPublicDirectories: discoverPublicDirectories as never,
      idFactory: () => 'search-durable-public-directories',
      now: () => 1000,
    });

    const started = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 50,
    });
    const snapshot = await service.advanceSearch(started.searchId);

    expect(discoverPublicDirectories).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ companyType: 'Dental Clinics' }),
        location: localLocation,
      }),
    );
    expect(snapshot?.meta.progress.providerCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'yelp-public-directory', leadCount: 1 }),
      expect.objectContaining({ providerId: 'yellow-pages-public-directory', leadCount: 0 }),
    ]));
    expect(snapshot?.leads).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Durable Yelp Dental', source: 'Yelp' }),
    ]));
  });

  it('recovers a public phone from a business website before GMB finalization', async () => {
    const enrichWebsiteLead = vi.fn().mockImplementation(async (lead: Lead) => ({
      lead: {
        ...lead,
        mobile: '+1 512 555 0118',
        hasPhone: true,
        verifiedPhone: true,
        contactEvidence: [{
          field: 'phone' as const,
          value: '+1 512 555 0118',
          sourceUrl: 'https://northstarlabs.ai/contact',
          sourceName: 'Public business website',
          sourceKind: 'business_website' as const,
          observedAt: new Date().toISOString(),
          association: 'business' as const,
        }],
      },
      warnings: [],
    }));
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      googlePlaces: {
        id: 'google-places',
        name: 'Google Places',
        fetchLeads: vi.fn().mockResolvedValue([
          makeLead({ mobile: '', hasPhone: false, verifiedPhone: false }),
        ]),
      } as never,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      enrichWebsiteLead,
      idFactory: () => 'search-website-recovery',
      now: () => Date.now(),
    });

    const response = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin, TX',
      count: 1,
    });
    const snapshot = await pollJob(service, response.searchId, 20);

    expect(enrichWebsiteLead).toHaveBeenCalledTimes(1);
    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads[0]?.mobile).toBe('+1 512 555 0118');
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

  it('persists the merged public-source AI result with LinkedIn evidence', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads: vi.fn().mockResolvedValue({
        leads: [makeLead({
          id: 'ai-linkedin-lead-1',
          contactSourceUrl: 'https://markdental.com/contact',
          name: 'Mark Sweeney',
          source: 'LinkedIn, Public Profile',
          listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
          sourceScore: 82,
        })],
        warnings: [],
        coverage: [{
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'returned',
          leadCount: 1,
        }],
        aiAssistance: 'enabled',
        researchCandidates: [],
        enrichedCount: 1,
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-ai-1',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });

    const snapshot = await pollJob(service, response.searchId, 3);

    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.currentSource).toBe('Complete');
    expect(snapshot?.leads).toHaveLength(1);
    expect(snapshot?.meta.sourceMode).toBe('ai');
    expect(snapshot?.leads[0]?.listingUrl).toContain('/in/');
    expect(snapshot?.meta.providerWarnings).toHaveLength(0);
  });

  it('resumes bounded OSM spatial boxes without re-running the earlier AI stages', async () => {
    const store = createSearchJobStore();
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [makeLead({ id: 'initial-linkedin', source: 'LinkedIn, Public Profile' })],
      warnings: [],
      coverage: [{
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        status: 'configured' as const,
        phase: 'queued' as const,
        outcome: 'deferred' as const,
        leadCount: 0,
        attemptedCount: 4,
        observedCount: 1,
        acceptedCount: 0,
        reviewCount: 1,
        deferredCount: 8,
        message: 'Initial OSM spatial batch completed; remaining boxes are deferred.',
      }],
      aiAssistance: 'disabled' as const,
      researchCandidates: [],
      reviewCandidates: [],
      enrichedCount: 0,
      publicListingProgress: {
        totalBoxCount: 12,
        nextBoxCursor: 4,
        attemptedBoxCount: 4,
        completedBoxCount: 4,
        failedBoxCount: 0,
        timedOut: false,
        completed: false,
        stoppedEarly: false,
      },
    });
    const discoverOsmLeadsBatch = vi.fn()
      .mockResolvedValueOnce({
        leads: [makeLead({ id: 'osm-continued-1', source: 'OpenStreetMap' })],
        totalBoxCount: 12,
        startBoxCursor: 4,
        nextBoxCursor: 8,
        attemptedBoxCount: 4,
        completedBoxCount: 4,
        failedBoxCount: 0,
        timedOut: false,
        completed: false,
        stoppedEarly: false,
      })
      .mockResolvedValueOnce({
        leads: [makeLead({ id: 'osm-continued-2', source: 'OpenStreetMap' })],
        totalBoxCount: 12,
        startBoxCursor: 8,
        nextBoxCursor: 12,
        attemptedBoxCount: 4,
        completedBoxCount: 4,
        failedBoxCount: 0,
        timedOut: false,
        completed: true,
        stoppedEarly: false,
      });
    const service = createVercelSearchServiceWithDeps({
      store,
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeadsBatch: discoverOsmLeadsBatch as never,
      idFactory: () => 'search-ai-osm-cursor',
      now: () => 1_000,
    });

    const started = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });
    await service.getSearch(started.searchId);
    await service.getSearch(started.searchId);
    const afterOsm = await service.getSearch(started.searchId);
    const job = await store.get(started.searchId);

    expect(discoverAiLeads).toHaveBeenCalledOnce();
    expect(discoverOsmLeadsBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ boxCursor: 4, maxBoxes: 4 }),
    );
    expect(discoverOsmLeadsBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ boxCursor: 8, maxBoxes: 4 }),
    );
    expect(job?.aiWorkflow).toMatchObject({
      stage: 'website_enrichment',
      osmBoxCursor: 12,
      osmTotalBoxes: 12,
      osmContinuationPasses: 2,
    });
    expect(afterOsm?.meta.progress.providerCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'public-business-listings',
        deferredCount: 0,
      }),
    ]));
  });

  it('persists AI query assistance and public LinkedIn coverage together', async () => {
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [makeLead({ id: 'ai-gemini-lens', source: 'LinkedIn, Public Profile' })],
      warnings: [],
      coverage: [{
        providerId: 'gemini-query-assistance',
        providerName: 'Gemini query assistance',
        status: 'returned',
        leadCount: 0,
      }, {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        status: 'returned',
        leadCount: 1,
      }],
      aiAssistance: 'enabled',
      researchCandidates: [],
      enrichedCount: 1,
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-ai-gemini-lenses',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'HVAC contractor',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });
    const snapshot = await service.getSearch(response.searchId);

    expect(discoverAiLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sourceMode: 'ai', companyType: 'HVAC contractor' }),
      }),
    );
    expect(snapshot?.meta.progress.aiAssistance).toBe('enabled');
    expect(snapshot?.meta.progress.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'gemini-query-assistance',
          status: 'returned',
        }),
        expect.objectContaining({
          providerId: 'linkedin-public-search',
          status: 'returned',
        }),
      ]),
    );
  });

  it('persists a public listing phone bridged onto a LinkedIn decision-maker in AI mode', async () => {
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [makeLead({
        id: 'ai-owner',
        name: 'Avery Smith',
        headline: 'Owner at Austin Dental Studio',
        source: 'LinkedIn, Public Profile, OpenStreetMap',
        listingUrl: 'https://linkedin.com/in/avery-smith',
        mobile: '+1 512 555 0199',
        contactSourceUrl: 'https://www.openstreetmap.org/node/456',
      })],
      warnings: [],
      coverage: [{
        providerId: 'public-business-listings',
        providerName: 'OpenStreetMap',
        status: 'returned',
        leadCount: 1,
      }],
      aiAssistance: 'enabled',
      researchCandidates: [],
      enrichedCount: 1,
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-ai-bridge',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
      phoneRequired: true,
    });
    const completed = await pollJob(service, response.searchId, 3);

    expect(discoverAiLeads).toHaveBeenCalledTimes(1);
    expect(discoverAiLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sourceMode: 'ai' }),
      }),
    );
    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(1);
    expect(completed?.leads[0]).toMatchObject({
      name: 'Avery Smith',
      mobile: '+1 512 555 0199',
      contactSourceUrl: 'https://www.openstreetmap.org/node/456',
    });
    expect(completed?.leads[0]?.listingUrl).toBe('https://linkedin.com/in/avery-smith');
  });

  it('returns the durable in-progress snapshot for overlapping AI polls', async () => {
    let markDiscoveryStarted = () => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery = (_result: AiDiscoveryResult) => {};
    const discoveryResult = new Promise<AiDiscoveryResult>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discoverAiLeads = vi.fn().mockImplementation(async () => {
      markDiscoveryStarted();
      return discoveryResult;
    });
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-ai-overlap',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });

    const firstPoll = service.getSearch(response.searchId);
    await discoveryStarted;

    const overlappingSnapshot = await service.getSearch(response.searchId);

    expect(overlappingSnapshot?.meta.status).toBe('discovering');
    expect(overlappingSnapshot?.meta.progress.currentSource).toBe('AI mode');
    expect(discoverAiLeads).toHaveBeenCalledOnce();

    releaseDiscovery({
      leads: [],
      warnings: [],
      coverage: [],
      aiAssistance: 'failed',
      researchCandidates: [],
      enrichedCount: 0,
    });
    const sourceSnapshot = await firstPoll;
    const completedSnapshot = await pollJob(service, response.searchId, 2);

    expect(sourceSnapshot?.meta.status).toBe('enriching');
    expect(completedSnapshot?.meta.status).toBe('failed');
    expect(completedSnapshot?.leads).toHaveLength(0);
  });

  it('does not duplicate AI discovery across service instances', async () => {
    const store = createSearchJobStore();
    let markDiscoveryStarted = () => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery = (_result: AiDiscoveryResult) => {};
    const discoveryResult = new Promise<AiDiscoveryResult>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discoverAiLeads = vi.fn().mockImplementation(async () => {
      markDiscoveryStarted();
      return discoveryResult;
    });
    const createService = () =>
      createVercelSearchServiceWithDeps({
        store,
        normalizeLocation: vi.fn().mockResolvedValue(localLocation),
        discoverAiLeads,
        discoverOsmLeads: vi.fn().mockResolvedValue([]),
        now: () => 1000,
      });
    const first = createService();
    const second = createService();

    const response = await first.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });

    const firstAdvance = first.advanceSearch(response.searchId);
    await discoveryStarted;

    const secondSnapshot = await second.advanceSearch(response.searchId);

    expect(secondSnapshot?.meta.status).toBe('discovering');
    expect(discoverAiLeads).toHaveBeenCalledOnce();

    releaseDiscovery({
      leads: [],
      warnings: [],
      coverage: [],
      aiAssistance: 'failed',
      researchCandidates: [],
      enrichedCount: 0,
    });
    const sourceSnapshot = await firstAdvance;
    const completedSnapshot = await pollJob(first, response.searchId, 2);

    expect(sourceSnapshot?.meta.status).toBe('enriching');
    expect(completedSnapshot?.meta.status).toBe('failed');
  });

  it('persists public contact enrichment inside the merged AI result', async () => {
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [makeLead({
        id: 'ai-enriched-lead',
        name: 'Mark Sweeney',
        source: 'LinkedIn, Public Profile, Public Web, Website Crawl',
        listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
        mobile: '+1 512 555 0199',
        email: 'hello@markdental.com',
        website: 'https://markdental.com',
        contactSourceUrl: 'https://markdental.com/contact',
        hasPhone: true,
        hasEmail: true,
        hasWebsite: true,
        verifiedPhone: true,
        verifiedEmail: true,
      })],
      warnings: [],
      coverage: [{
        providerId: 'public-website-enrichment',
        providerName: 'Public Website Enrichment',
        status: 'returned',
        leadCount: 1,
      }],
      aiAssistance: 'enabled',
      researchCandidates: [],
      enrichedCount: 1,
    });

    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-ai-enriched',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });
    const snapshot = await pollJob(service, response.searchId, 3);

    expect(discoverAiLeads).toHaveBeenCalledTimes(1);
    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.leads[0]).toMatchObject({
      email: 'hello@markdental.com',
      mobile: '+1 512 555 0199',
      website: 'https://markdental.com',
    });
    expect(snapshot?.leads[0]?.source).toContain('Website Crawl');
    expect(snapshot?.meta.progress.enriched).toBe(1);
  });

  it('fails AI searches honestly when public profile pages are blocked', async () => {
    const service = createVercelSearchServiceWithDeps({
      store: createSearchJobStore(),
      normalizeLocation: vi.fn().mockResolvedValue(localLocation),
      discoverAiLeads: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [
          {
            providerId: 'linkedin-search-brave',
            providerName: 'Brave Search',
            message: 'Public profile search was blocked or rate-limited.',
          },
        ],
        coverage: [{
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'failed',
          leadCount: 0,
        }],
        aiAssistance: 'failed',
        researchCandidates: [],
        enrichedCount: 0,
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      idFactory: () => 'search-linkedin-blocked',
      now: () => 1000,
    });

    const response = await service.startSearch({
      companyType: 'Founder',
      city: 'Austin, TX',
      count: 50,
      sourceMode: 'ai',
    });

    const snapshot = await pollJob(service, response.searchId, 3);

    expect(snapshot?.meta.status).toBe('failed');
    expect(snapshot?.meta.progress.currentSource).toBe('Failed');
    expect(snapshot?.leads).toHaveLength(0);
    expect(snapshot?.meta.providerWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'linkedin-search-brave' }),
        expect.objectContaining({ providerId: 'no-usable-results', severity: 'error' }),
      ]),
    );
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

    expect(snapshot?.meta.status).toBe('failed');
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

    expect(snapshot?.meta.status).toBe('failed');
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
      researchCandidates: [],
      enrichedCount: 0,
      publicCoverage: {
        queriesAttempted: 10,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 1,
        queryFamilies: ['role-led'],
        queryFamilyCounts: { 'role-led': 10 },
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
    const snapshot = await pollJob(service, started.searchId, 3);

    expect(discoverAiLeads).toHaveBeenCalledTimes(1);
    expect(googleFetchLeads).not.toHaveBeenCalled();
    expect(discoverOsmLeads).not.toHaveBeenCalled();
    expect(snapshot?.meta.status).toBe('complete');
    expect(snapshot?.meta.progress.providerCoverage?.[0]?.providerName).toBe('Apollo');
    expect(snapshot?.meta.progress.publicQueriesAttempted).toBe(10);
    expect(snapshot?.leads[0]?.source).toContain('LinkedIn');
  });
});
