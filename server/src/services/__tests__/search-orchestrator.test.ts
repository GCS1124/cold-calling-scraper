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

describe('createSearchService', () => {
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

  it('stops a no-progress discovery after the 20-second stall window expires', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;
    const googleCalls: string[] = [];
    let nowCalls = 0;

    const service = createSearchService({
      idFactory: () => 'search-4b',
      now: () => {
        nowCalls += 1;
        return nowCalls <= 2 ? 0 : 25_000;
      },
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

    const task = backgroundTask as () => Promise<void>;
    await task();
    const completed = await service.getSearch('search-4b');

    expect(completed?.meta.status).toBe('complete');
    expect(completed?.meta.providerWarnings.some((warning) => warning.providerId === 'discovery-limit')).toBe(true);
    expect(googleCalls.length).toBe(1);
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

    expect(result?.meta.status).toBe('complete');
    expect(result?.meta.providerWarnings.some((warning) => warning.message.includes('California'))).toBe(true);
  });
});
