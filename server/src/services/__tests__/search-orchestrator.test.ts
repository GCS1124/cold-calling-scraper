import { describe, expect, it, vi } from 'vitest';

import { createSearchService } from '../search-orchestrator';
import type { Lead } from '../../types/lead';

const sampleLead: Lead = {
  id: 'lead-1',
  name: 'Lattice Dental',
  mobile: '5125550101',
  email: '',
  website: 'https://latticedental.com',
  address: '123 Congress Ave, Austin, TX 78701',
  category: 'Dental Clinics',
  city: 'Austin, TX',
  source: 'OpenStreetMap',
  confidence: 70,
  sourceScore: 65,
  rejectionReason: 'missing_email',
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  listingUrl: 'https://www.openstreetmap.org/node/lead-1',
  scrapedAt: '2026-04-21T00:00:00.000Z',
};

const sampleLocation = {
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  mode: 'local' as const,
  lat: 30.2672,
  lon: -97.7431,
  postalCode: '78701',
  boundingBox: {
    south: 30,
    west: -98,
    north: 31,
    east: -97,
  },
  warnings: [],
};

const nationwideLocation = {
  label: 'United States',
  city: '',
  stateCode: '',
  mode: 'nationwide' as const,
  lat: 39.8283,
  lon: -98.5795,
  postalCode: undefined,
  boundingBox: {
    south: 24.3963,
    west: -125.0,
    north: 49.3845,
    east: -66.9346,
  },
  warnings: [],
};

const timezoneLocation = {
  label: 'Eastern Time',
  city: 'Eastern Time',
  stateCode: '',
  mode: 'timezone' as const,
  timeZoneCode: 'ET' as const,
  lat: 39.8283,
  lon: -98.5795,
  postalCode: undefined,
  boundingBox: {
    south: 24.3963,
    west: -92.0,
    north: 47.4597,
    east: -66.9346,
  },
  warnings: [],
};

describe('createSearchService', () => {
  it('reuses a local queued search for the same idempotency key', async () => {
    const scheduledTasks: Array<() => Promise<void>> = [];
    let id = 0;
    const service = createSearchService({
      idFactory: () => `local-idempotency-${++id}`,
      schedule: (task) => {
        scheduledTasks.push(task);
      },
    });
    const request = {
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
    } as const;

    const first = await service.startSearch(request, { idempotencyKey: 'local-retry-1' });
    const replay = await service.startSearch(request, { idempotencyKey: 'local-retry-1' });

    expect(replay.searchId).toBe(first.searchId);
    expect(scheduledTasks).toHaveLength(1);
    await expect(
      service.startSearch({ ...request, count: 100 }, { idempotencyKey: 'local-retry-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('isolates local search jobs by owner and rejects cross-owner idempotency reuse', async () => {
    const service = createSearchService({
      idFactory: () => 'owned-search-1',
      schedule: () => undefined,
    });
    const request = {
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
    } as const;

    const started = await service.startSearch(request, {
      idempotencyKey: 'owned-retry-1',
      ownerId: 'owner-a',
    });

    await expect(service.getSearch(started.searchId, { ownerId: 'owner-a' })).resolves.toMatchObject({
      searchId: started.searchId,
    });
    await expect(service.getSearch(started.searchId, { ownerId: 'owner-b' })).resolves.toBeNull();
    await expect(
      service.startSearch(request, { idempotencyKey: 'owned-retry-1', ownerId: 'owner-b' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(service.cancelSearch(started.searchId, { ownerId: 'owner-b' })).resolves.toBeNull();
  });

  it('starts queued and becomes failed when US normalization fails', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      normalizeLocation: vi.fn().mockRejectedValue(new Error('No US location match found')),
      idFactory: () => 'search-1',
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    const started = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Paris',
      count: 50,
    });

    expect(started.searchId).toBe('search-1');
    expect(started.meta.status).toBe('queued');

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }
    const task = backgroundTask as () => Promise<void>;
    await task();
    const failed = await service.getSearch('search-1');

    expect(failed?.meta.status).toBe('failed');
    expect(failed?.meta.providerWarnings[0]?.message).toContain('No US location match found');
  });

  it('preserves cancellation when queued work starts after the user stops it', async () => {
    const scheduledTasks: Array<() => Promise<void>> = [];
    const service = createSearchService({
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      idFactory: () => 'search-cancelled-queued',
      schedule: (task) => {
        scheduledTasks.push(task);
      },
    });

    await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin',
      count: 50,
    });
    const cancelled = await service.cancelSearch('search-cancelled-queued');

    expect(cancelled?.meta.status).toBe('cancelled');
    await scheduledTasks[0]!();
    expect((await service.getSearch('search-cancelled-queued'))?.meta.status).toBe('cancelled');
  });

  it('resumes a cancelled local job without allowing the stale run to overwrite it', async () => {
    const scheduledTasks: Array<() => Promise<void>> = [];
    let resolveLocation: ((value: typeof sampleLocation) => void) | undefined;
    const locationPromise = new Promise<typeof sampleLocation>((resolve) => {
      resolveLocation = resolve;
    });
    const service = createSearchService({
      normalizeLocation: vi.fn().mockReturnValue(locationPromise),
      idFactory: () => 'search-cancel-race',
      schedule: (task) => {
        scheduledTasks.push(task);
      },
    });

    await service.startSearch({ companyType: 'Dentist', city: 'Austin', count: 50 });
    const staleRun = scheduledTasks[0]!();
    await service.cancelSearch('search-cancel-race');
    const resumed = await service.resumeSearch('search-cancel-race');

    expect(resumed?.meta.status).toBe('discovering');
    resolveLocation!(sampleLocation);
    await staleRun;

    expect((await service.getSearch('search-cancel-race'))?.meta.status).toBe('discovering');
    expect(scheduledTasks).toHaveLength(2);
  });

  it('progresses from queued to discovering while background work continues under target', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-2',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([sampleLead]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    const started = await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    expect(started.meta.status).toBe('queued');
    expect(started.meta.locationLabel).toBe('Austin');

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }
    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-2');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.locationLabel).toBe('Austin, TX');
    expect(completed?.meta.progress.foundCount).toBe(1);
    expect(completed?.meta.progress.enriched).toBe(0);
    expect(completed?.leads[0]?.name).toBe('Lattice Dental');
  });

  it('filters the durable result to validated public-phone leads', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const leadWithoutPhone: Lead = {
      ...sampleLead,
      id: 'lead-without-phone',
      name: 'Phone Missing Dental',
      mobile: '',
      website: 'https://phone-missing-dental.example',
      listingUrl: 'https://www.openstreetmap.org/node/lead-without-phone',
      address: '456 Congress Ave, Austin, TX 78701',
      hasPhone: false,
      verifiedPhone: false,
    };

    const service = createSearchService({
      idFactory: () => 'search-phone-required',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([leadWithoutPhone, sampleLead]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
      phoneRequired: true,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-phone-required');

    expect(completed?.leads).toHaveLength(1);
    expect(completed?.leads[0]?.name).toBe('Lattice Dental');
    expect(completed?.leads.every((lead) => lead.hasPhone && lead.verifiedPhone)).toBe(true);
    expect(completed?.meta.providerWarnings).toContainEqual(
      expect.objectContaining({
        providerId: 'phone-required',
        message: expect.stringContaining('Excluded 1 lead'),
      }),
    );
  });

  it('caps the completed result at the requested count after ranking the candidate pool', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const candidates = Array.from({ length: 75 }, (_, index) => ({
      ...sampleLead,
      id: `lead-${index + 1}`,
      name: `Lattice Dental ${index + 1}`,
      mobile: `512555${String(1000 + index)}`,
      website: `https://lattice-dental-${index + 1}.com`,
      listingUrl: `https://www.openstreetmap.org/node/lead-${index + 1}`,
      address: `${100 + index} Congress Ave, Austin, TX 78701`,
    }));

    const service = createSearchService({
      idFactory: () => 'search-count-cap',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue(candidates),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-count-cap');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(50);
    expect(completed?.meta.progress.foundCount).toBe(50);
  });

  it('runs the merged public-source AI mode through the durable local lifecycle', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [
        {
          ...sampleLead,
          id: 'ai-linkedin-lead-1',
          name: 'Mark Sweeney',
          source: 'LinkedIn, Public Profile, Public Website',
          listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
          mobile: '+1 512 555 0101',
          contactSourceUrl: 'https://www.openstreetmap.org/node/123',
          hasPhone: true,
          verifiedPhone: true,
        },
      ],
      warnings: [],
      coverage: [
        {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'returned',
          leadCount: 1,
        },
      ],
      aiAssistance: 'enabled',
      researchCandidates: [],
      enrichedCount: 1,
    });
    const service = createSearchService({
      idFactory: () => 'search-ai-1',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverAiLeads,
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    const started = await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin',
      count: 50,
      sourceMode: 'ai',
    });

    expect(started.meta.sourceMode).toBe('ai');
    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    await (backgroundTask as () => Promise<void>)();
    const completed = await service.getSearch('search-ai-1');

    expect(discoverAiLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sourceMode: 'ai' }),
        location: sampleLocation,
        deadlineMs: expect.any(Number),
      }),
    );
    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.sourceMode).toBe('ai');
    expect(completed?.leads[0]?.name).toBe('Mark Sweeney');
    expect(completed?.leads[0]?.listingUrl).toContain('/in/');
    expect(completed?.meta.progress.aiAssistance).toBe('enabled');
    expect(completed?.meta.progress.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'linkedin-public-search',
          leadCount: 1,
        }),
      ]),
    );
  });

  it('keeps the AI result when public LinkedIn and listing evidence are fused upstream', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [
        {
          ...sampleLead,
          id: 'ai-owner',
          name: 'Avery Smith',
          headline: 'Owner at Austin Dental Studio',
          source: 'LinkedIn, Public Profile, OpenStreetMap',
          listingUrl: 'https://linkedin.com/in/avery-smith',
          mobile: '+1 512 555 0199',
          contactSourceUrl: 'https://www.openstreetmap.org/node/456',
          hasPhone: true,
          verifiedPhone: true,
        },
      ],
      warnings: [],
      coverage: [
        {
          providerId: 'public-business-listings',
          providerName: 'OpenStreetMap',
          status: 'returned',
          leadCount: 1,
        },
      ],
      aiAssistance: 'enabled',
      researchCandidates: [],
      enrichedCount: 1,
    });
    const service = createSearchService({
      idFactory: () => 'search-ai-bridge',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverAiLeads,
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin',
      count: 50,
      sourceMode: 'ai',
      phoneRequired: true,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    await (backgroundTask as () => Promise<void>)();
    const completed = await service.getSearch('search-ai-bridge');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads[0]).toMatchObject({
      name: 'Avery Smith',
      mobile: '+1 512 555 0199',
      contactSourceUrl: 'https://www.openstreetmap.org/node/456',
    });
    expect(completed?.leads[0]?.listingUrl).toBe('https://linkedin.com/in/avery-smith');
  });

  it('keeps public contact enrichment in the merged AI result', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const discoverAiLeads = vi.fn().mockResolvedValue({
      leads: [{
        ...sampleLead,
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
      }],
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
    const service = createSearchService({
      idFactory: () => 'search-ai-enriched',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverAiLeads,
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin',
      count: 50,
      sourceMode: 'ai',
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    await (backgroundTask as () => Promise<void>)();
    const completed = await service.getSearch('search-ai-enriched');

    expect(completed?.leads[0]).toMatchObject({
      email: 'hello@markdental.com',
      mobile: '+1 512 555 0199',
      website: 'https://markdental.com',
    });
    expect(completed?.leads[0]?.source).toContain('Website Crawl');
    expect(completed?.meta.progress.enriched).toBe(1);
  });

  it('preserves qualified AI candidates when an optional public source reports a warning', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const service = createSearchService({
      idFactory: () => 'search-ai-warning',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverAiLeads: vi.fn().mockResolvedValue({
        leads: [{
          ...sampleLead,
          id: 'ai-warning-lead',
          name: 'Mark Sweeney',
          source: 'LinkedIn, Public Profile',
          listingUrl: 'https://linkedin.com/in/mark-sweeney-austin',
          mobile: '+1 512 555 0199',
          contactSourceUrl: 'https://markdental.com/contact',
          hasPhone: true,
          verifiedPhone: true,
        }],
        warnings: [{
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          message: 'Public contact provider unavailable. Discovered public profiles were kept.',
        }],
        coverage: [{
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          status: 'failed',
          leadCount: 0,
        }],
        aiAssistance: 'enabled',
        researchCandidates: [],
        enrichedCount: 0,
      }),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dentist',
      city: 'Austin',
      count: 50,
      sourceMode: 'ai',
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    await (backgroundTask as () => Promise<void>)();
    const completed = await service.getSearch('search-ai-warning');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(1);
    expect(completed?.meta.providerWarnings).toContainEqual(
      expect.objectContaining({ providerId: 'public-website-enrichment' }),
    );
  });

  it('fails AI mode honestly when public profile discovery is blocked', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-ai-blocked',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
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
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    const started = await service.startSearch({
      companyType: 'Founder',
      city: 'Austin',
      count: 50,
      sourceMode: 'ai',
    });

    expect(started.meta.status).toBe('queued');

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-ai-blocked');

    expect(completed?.meta.status).toBe('failed');
    expect(completed?.meta.progress.currentSource).toBe('Failed');
    expect(completed?.leads).toHaveLength(0);
    expect(completed?.meta.providerWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'linkedin-search-brave' }),
        expect.objectContaining({ providerId: 'no-usable-results', severity: 'error' }),
      ]),
    );
  });

  it('fans out Austin city-state searches across local seed variants before finishing', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const googleCalls: string[] = [];

    const service = createSearchService({
      idFactory: () => 'search-2b',
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'Austin') {
          return sampleLocation;
        }

        if (
          input === 'Austin, TX' ||
          input === 'Austin TX' ||
          input === 'Austin, Texas' ||
          input === 'Austin Texas'
        ) {
          return {
            ...sampleLocation,
            label: input,
          };
        }

        if (
          input === 'Austin area' ||
          input === 'greater Austin' ||
          input === 'Austin metro' ||
          input === 'Austin metro area' ||
          input === 'downtown Austin' ||
          input === 'central Austin'
        ) {
          return {
            ...sampleLocation,
            label: input,
          };
        }

        return sampleLocation;
      }),
      discoverGoogleLeads: vi.fn().mockImplementation(async ({ location }) => {
        googleCalls.push(location.label);

        if (location.label === 'Austin area' || location.label === 'greater Austin') {
          return [
            {
              ...sampleLead,
              id: `lead-${location.label}`,
              source: 'Google Places',
              address: '500 Congress Ave, Austin, TX 78701',
              city: 'Austin, TX',
            },
          ];
        }

        return [];
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-2b');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(1);
    expect(googleCalls).toEqual(expect.arrayContaining(['Austin area', 'greater Austin']));
  });

  it('bounds broad-location normalization so public geocoding is not bursty', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    let activeNormalizations = 0;
    let peakNormalizations = 0;

    const service = createSearchService({
      idFactory: () => 'search-normalization-bound',
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        activeNormalizations += 1;
        peakNormalizations = Math.max(peakNormalizations, activeNormalizations);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeNormalizations -= 1;

        if (input === 'Eastern Time') return timezoneLocation;
        return {
          ...sampleLocation,
          label: input,
          city: input.split(',')[0] ?? input,
        };
      }),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'HVAC contractor',
      city: 'Eastern Time',
      count: 50,
    });

    const scheduledTask = backgroundTask as (() => Promise<void>) | null;
    if (!scheduledTask) throw new Error('Background task was not scheduled');
    await scheduledTask();

    expect(peakNormalizations).toBeLessThanOrEqual(4);
  });

  it('keeps category warnings while keeping the job open until the target is met', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-3',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([
        {
          ...sampleLead,
          website: '',
          hasWebsite: false,
          confidence: 52,
          rejectionReason: 'missing_email',
        },
      ]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    const started = await service.startSearch({
      companyType: 'Custom Niche Query',
      city: 'Austin',
      count: 50,
    });

    expect(started.meta.status).toBe('queued');

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }
    const task = backgroundTask as () => Promise<void>;
    await task();
    const result = await service.getSearch('search-3');

    expect(result?.meta.status).toBe('complete');
    expect(result?.leads).toHaveLength(1);
    expect(result?.meta.providerWarnings).toEqual([
      expect.objectContaining({
        providerId: 'osm-category-map',
      }),
    ]);
  });

  it('drops out-of-area provider candidates before merge and dedupe', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-3b',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([
        {
          ...sampleLead,
          id: 'good-1',
          source: 'Google Places',
          address: '500 Congress Ave, Austin, TX 78701',
          city: 'Austin, TX',
        },
        {
          ...sampleLead,
          id: 'bad-1',
          source: 'Google Maps',
          address: '200 Main St, Round Rock, TX 78664',
          city: 'Round Rock, TX',
        },
        {
          ...sampleLead,
          id: 'bad-2',
          source: 'Google Places',
          address: '',
        },
      ]),
      discoverOsmLeads: vi.fn().mockResolvedValue([
        {
          ...sampleLead,
          id: 'bad-3',
          source: 'OpenStreetMap',
          address: '1000 Commerce St, Dallas, TX 75201',
          city: 'Dallas, TX',
        },
      ]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-3b');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.progress.foundCount).toBe(1);
    expect(completed?.leads).toHaveLength(1);
    expect(completed?.leads[0]?.address).toContain('Austin, TX');
  });

  it('keeps Google Maps coordinate matches when Google Places is short', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-3c',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverGoogleMapsLeads: vi.fn().mockResolvedValue([
        {
          ...sampleLead,
          id: 'lead-maps-austin',
          source: 'Google Maps',
          address: '',
          city: '',
          latitude: 30.2672,
          longitude: -97.7431,
          website: 'https://austinac.com',
          mobile: '+1 512 555 0101',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
        },
      ]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-3c');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(1);
    expect(completed?.leads[0]?.source).toContain('Google Maps');
  });

  it('pauses a failed Google Maps fallback for the rest of the search', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const discoverGoogleMapsLeads = vi.fn().mockRejectedValue(
      new Error('page.goto: net::ERR_INSUFFICIENT_RESOURCES at https://www.google.com/maps/...'),
    );

    const service = createSearchService({
      idFactory: () => 'search-maps-failure',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverGoogleMapsLeads,
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    await (backgroundTask as () => Promise<void>)();
    const completed = await service.getSearch('search-maps-failure');

    expect(completed?.meta.status).toBe('failed');
    expect(discoverGoogleMapsLeads).toHaveBeenCalledTimes(1);
    expect(
      completed?.meta.providerWarnings.some((warning) =>
        warning.message.includes('browser resource limit'),
      ),
    ).toBe(true);
    expect(
      completed?.meta.providerWarnings.some((warning) =>
        warning.message.includes('www.google.com/maps/...'),
      ),
    ).toBe(false);
  });

  it('keeps Google Maps coordinate matches inside a timezone search', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-3d',
      normalizeLocation: vi.fn().mockImplementation(async (input: string) => {
        if (input === 'Eastern Time') {
          return timezoneLocation;
        }

        return sampleLocation;
      }),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverGoogleMapsLeads: vi.fn().mockResolvedValue([
        {
          ...sampleLead,
          id: 'lead-maps-east',
          source: 'Google Maps',
          address: '',
          city: 'New York, NY',
          latitude: 40.7128,
          longitude: -74.006,
          website: 'https://newyorkhvac.com',
          mobile: '+1 212 555 0101',
          hasPhone: true,
          hasWebsite: true,
          verifiedPhone: true,
        },
      ]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'HVAC Contractors',
      city: 'Eastern Time',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-3d');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.leads).toHaveLength(1);
    expect(completed?.leads[0]?.source).toContain('Google Maps');
  });

  it('fans out a nationwide search across multiple regional discovery batches without closing early', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const googleCalls: string[] = [];
    const osmCalls: string[] = [];

    const service = createSearchService({
      idFactory: () => 'search-4',
      normalizeLocation: vi.fn().mockResolvedValue(nationwideLocation),
      discoverGoogleLeads: vi.fn().mockImplementation(async ({ location }) => {
        googleCalls.push(location.label);
        return [
          {
            ...sampleLead,
            id: `google-lead-${googleCalls.length}`,
            source: 'Google Maps',
            city: location.label,
            sourceScore: 90,
          },
        ];
      }),
      discoverOsmLeads: vi.fn().mockImplementation(async ({ location }) => {
        osmCalls.push(location.label);
        return [
          {
            ...sampleLead,
            id: `osm-lead-${osmCalls.length}`,
            source: 'OpenStreetMap',
            city: location.label,
            sourceScore: 70,
          },
        ];
      }),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Law Firms',
      city: 'USA',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-4');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.locationLabel).toBe('United States');
    expect(googleCalls.length).toBeGreaterThan(1);
    expect(osmCalls.length).toBeGreaterThan(1);
    expect(completed?.leads.length).toBeGreaterThanOrEqual(1);
  });

  it('stops a no-progress discovery after the 45-second stall window expires', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const googleCalls: string[] = [];
    let currentTime = 0;

    const service = createSearchService({
      idFactory: () => 'search-4b',
      now: () => currentTime,
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockImplementation(async ({ location }) => {
        googleCalls.push(location.label);
        return [];
      }),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    currentTime = 50_000;
    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-4b');

    expect(completed?.meta.status).toBe('failed');
    expect(completed?.meta.providerWarnings.some((warning) => warning.providerId === 'discovery-limit')).toBe(true);
    expect(googleCalls.length).toBe(0);
  });

  it('keeps the job running when a regional seed fails to normalize', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-5',
      normalizeLocation: vi.fn().mockImplementation(async (rawLocation: string) => {
        if (rawLocation === 'Austin') {
          return sampleLocation;
        }

        if (rawLocation === 'TX') {
          return sampleLocation;
        }

        if (rawLocation === 'California, USA') {
          throw new Error('429 Too Many Requests');
        }

        return nationwideLocation;
      }),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([]),
      schedule: (task) => {
        backgroundTask = task;
      },
    });

    await service.startSearch({
      companyType: 'Dental Clinics',
      city: 'USA',
      count: 50,
    });

    if (!backgroundTask) {
      throw new Error('Background task was not scheduled');
    }

    const task = backgroundTask as () => Promise<void>;
    await task();
    const result = await service.getSearch('search-5');

    expect(result?.meta.status).toBe('failed');
    expect(result?.meta.providerWarnings.some((warning) => warning.message.includes('California'))).toBe(true);
  });
});
