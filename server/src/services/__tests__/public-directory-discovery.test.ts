import { describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import type { NormalizedUsLocation } from '../us-location';
import { createPublicDirectoryDiscovery } from '../public-directory-discovery';
import type { LeadProvider } from '../../providers/provider';

const localLocation: NormalizedUsLocation = {
  mode: 'local',
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  postalCode: '78701',
  lat: 30.2672,
  lon: -97.7431,
  boundingBox: { south: 30, west: -98, north: 31, east: -97 },
  warnings: [],
};

const easternTimeLocation: NormalizedUsLocation = {
  mode: 'timezone',
  label: 'Eastern Time',
  city: 'Eastern Time',
  stateCode: '',
  timeZoneCode: 'ET',
  lat: 39.5,
  lon: -78.5,
  boundingBox: { south: 24.3963, west: -92, north: 47.4597, east: -66.9346 },
  warnings: [],
};

const makeLead = (source: string, city = 'Austin, TX'): Lead => ({
  id: `${source.toLowerCase().replace(/\s+/g, '-')}-${city}`,
  name: `${source} Public Result ${city}`,
  mobile: '+15125550101',
  email: '',
  website: '',
  address: city,
  category: 'HVAC contractor',
  city,
  source,
  confidence: 64,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: false,
  verifiedPhone: true,
  verifiedEmail: false,
  listingUrl: source === 'Yelp'
    ? 'https://www.yelp.com/biz/public-result'
    : 'https://www.yellowpages.com/biz/public-result',
  contactSourceUrl: source === 'Yelp'
    ? 'https://www.yelp.com/biz/public-result'
    : 'https://www.yellowpages.com/biz/public-result',
  contactEvidence: [{
    field: 'phone',
    value: '+15125550101',
    sourceUrl: source === 'Yelp'
      ? 'https://www.yelp.com/biz/public-result'
      : 'https://www.yellowpages.com/biz/public-result',
    sourceName: `${source}, Public Directory`,
    sourceKind: 'business_listing',
    association: 'business',
  }],
  scrapedAt: new Date().toISOString(),
});

const makeProvider = (id: string, source: string, result?: Lead[]) => ({
  id,
  name: source,
  fetchLeads: vi.fn().mockResolvedValue(result ?? [makeLead(source)]),
}) satisfies LeadProvider;

describe('public directory discovery', () => {
  it.each([
    'HVAC contractor',
    'Dental Clinics',
    'Immigration Attorneys',
    'Roofing Contractors',
    'Mobile Notary Signing Agent',
  ])('sends the search heading to every directory for "%s"', async (companyType) => {
    const yelp = makeProvider('yelp', 'Yelp');
    const yellowPages = makeProvider('yellow-pages', 'Yellow Pages');
    const discovery = createPublicDirectoryDiscovery({
      providers: [yelp, yellowPages],
    });

    const result = await discovery({
      request: { companyType, city: 'Austin, TX', count: 50 },
      location: localLocation,
    });

    expect(yelp.fetchLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: `${companyType} in Austin, TX`,
        request: expect.objectContaining({ companyType, city: 'Austin, TX', phoneRequired: true }),
      }),
    );
    expect(yellowPages.fetchLeads).toHaveBeenCalledTimes(1);
    expect(result.leads).toHaveLength(2);
    expect(result.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'yelp-public-directory', status: 'returned', leadCount: 1 }),
      expect.objectContaining({ providerId: 'yellow-pages-public-directory', status: 'returned', leadCount: 1 }),
    ]));
  });

  it('fans broad searches across concrete US seeds and keeps the other directory alive on failure', async () => {
    const yelp = makeProvider('yelp', 'Yelp');
    const yellowPages = makeProvider('yellow-pages', 'Yellow Pages');
    yelp.fetchLeads.mockImplementation(async ({ request }) => [makeLead('Yelp', request.city)]);
    yellowPages.fetchLeads.mockRejectedValue(new Error('Cloudflare challenge'));
    const discovery = createPublicDirectoryDiscovery({
      providers: [yelp, yellowPages],
      maxConcurrent: 4,
    });

    const result = await discovery({
      request: { companyType: 'HVAC contractor', city: 'Eastern Time', count: 50 },
      location: easternTimeLocation,
    });

    expect(yelp.fetchLeads.mock.calls.length).toBeGreaterThan(1);
    expect(new Set(yelp.fetchLeads.mock.calls.map(([input]) => input.request.city)).size).toBeGreaterThan(1);
    expect(result.leads.length).toBeGreaterThan(0);
    expect(result.coverage.find((entry) => entry.providerId === 'yelp-public-directory')).toMatchObject({
      attemptedCount: expect.any(Number),
      observedCount: 1,
      acceptedCount: 1,
      leadCount: 1,
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        providerId: 'yellow-pages-public-directory',
        message: expect.stringContaining('Cloudflare challenge'),
      }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'yellow-pages-public-directory',
        status: 'partial',
      }),
    );
  });

  it('reports unstarted directory work as deferred instead of an empty provider result', async () => {
    const yelp = makeProvider('yelp', 'Yelp');
    const yellowPages = makeProvider('yellow-pages', 'Yellow Pages');
    const discovery = createPublicDirectoryDiscovery({ providers: [yelp, yellowPages] });

    const result = await discovery({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location: localLocation,
      deadlineMs: Date.now() - 1,
    });

    expect(yelp.fetchLeads).not.toHaveBeenCalled();
    expect(yellowPages.fetchLeads).not.toHaveBeenCalled();
    expect(result.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'yelp-public-directory',
        phase: 'queued',
        outcome: 'deferred',
        deferredCount: 1,
      }),
      expect.objectContaining({
        providerId: 'yellow-pages-public-directory',
        phase: 'queued',
        outcome: 'deferred',
        deferredCount: 1,
      }),
    ]));
  });
});
