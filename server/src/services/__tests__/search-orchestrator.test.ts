import { describe, expect, it, vi } from 'vitest';

import { createSearchService } from '../search-orchestrator';
import type { Lead } from '../../types/lead';

const sampleLead: Lead = {
  id: 'lead-1',
  name: 'Lattice Dental',
  mobile: '5125550101',
  email: '',
  website: 'https://latticedental.com',
  address: '',
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

  it('progresses from queued to qualifying after background enrichment when still under target', async () => {
    let backgroundTask: (() => Promise<void>) | null = null;

    const service = createSearchService({
      idFactory: () => 'search-2',
      normalizeLocation: vi.fn().mockResolvedValue(sampleLocation),
      discoverGoogleLeads: vi.fn().mockResolvedValue([]),
      discoverOsmLeads: vi.fn().mockResolvedValue([sampleLead]),
      enrichLead: vi.fn().mockResolvedValue({
        lead: {
          ...sampleLead,
          email: 'hello@latticedental.com',
          source: 'OpenStreetMap, Website Crawl',
          hasEmail: true,
          verifiedEmail: true,
          rejectionReason: undefined,
          confidence: 92,
        },
        warnings: [],
      }),
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

    expect(completed?.meta.status).toBe('discovering');
    expect(completed?.meta.locationLabel).toBe('Austin, TX');
    expect(completed?.meta.progress.enriched).toBe(1);
    expect(completed?.meta.progress.foundCount).toBe(1);
    expect(completed?.leads[0]?.email).toBe('hello@latticedental.com');
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

    expect(result?.meta.status).toBe('discovering');
    expect(result?.leads).toHaveLength(1);
    expect(result?.meta.providerWarnings).toEqual([
      expect.objectContaining({
        providerId: 'osm-category-map',
      }),
    ]);
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

    expect(completed?.meta.status).toBe('enriching');
    expect(completed?.meta.locationLabel).toBe('United States');
    expect(completed?.meta.progress.currentSource).toBe('Website Crawl');
    expect(googleCalls.length).toBeGreaterThan(1);
    expect(osmCalls.length).toBeGreaterThan(1);
    expect(completed?.leads.length).toBeGreaterThanOrEqual(1);
  });
});
