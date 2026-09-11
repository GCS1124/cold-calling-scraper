import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead, ResearchCandidate } from '../../types/lead';
import { buildAiGmbSearchPlan, createAiLeadDiscovery } from '../ai-lead-discovery';
import { resolveCategoryProfile } from '../us-category-mapping';
import type { NormalizedUsLocation } from '../us-location';

const location: NormalizedUsLocation = {
  mode: 'local',
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

const easternTimeLocation: NormalizedUsLocation = {
  mode: 'timezone',
  label: 'Eastern Time',
  city: 'Eastern Time',
  stateCode: '',
  timeZoneCode: 'ET',
  lat: 39.5,
  lon: -78.5,
  boundingBox: {
    south: 24.3963,
    west: -92,
    north: 47.4597,
    east: -66.9346,
  },
  warnings: [],
};

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'linkedin-lead-1',
  name: 'Avery Smith',
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
  listingUrl: 'https://linkedin.com/in/avery-smith',
  hasEmail: false,
  hasPhone: false,
  hasWebsite: true,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGeminiFlag = process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
const originalGeminiDiscoveryFlag = process.env.GEMINI_LEAD_DISCOVERY_ENABLED;

afterEach(() => {
  if (originalGeminiApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
  }
  if (originalGeminiFlag === undefined) {
    delete process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
  } else {
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = originalGeminiFlag;
  }
  if (originalGeminiDiscoveryFlag === undefined) {
    delete process.env.GEMINI_LEAD_DISCOVERY_ENABLED;
  } else {
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = originalGeminiDiscoveryFlag;
  }
});

describe('free AI lead discovery', () => {
  it('prioritizes concrete cities for a broad timezone GMB search', () => {
    const plan = buildAiGmbSearchPlan(
      'HVAC contractor',
      easternTimeLocation,
      resolveCategoryProfile('HVAC contractor'),
    );

    expect(plan.query).toMatch(/New York, NY/i);
    expect(plan.query).not.toMatch(/Eastern Time/i);
    expect(plan.queryVariants.slice(0, 7).some((query) => /Miami, FL|Atlanta, GA|Charlotte, NC/i.test(query))).toBe(
      true,
    );
  });

  it('uses public LinkedIn and website sources without commercial credentials', async () => {
    const discoverLinkedin = vi.fn().mockResolvedValue({
      leads: [makeLead()],
      warnings: [],
      blocked: false,
      coverage: {
        queriesAttempted: 12,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 1,
        queryFamilies: ['role-led'],
        queryFamilyCounts: { 'role-led': 12 },
      },
    });
    const enrichPublicContacts = vi.fn().mockResolvedValue({
      leads: [
        makeLead({
          email: 'hello@austindentalstudio.com',
          hasEmail: true,
          verifiedEmail: true,
        }),
      ],
      warnings: [],
      enrichedCount: 1,
    });

    const discovery = createAiLeadDiscovery({
      discoverLinkedin: discoverLinkedin as never,
      enrichPublicContacts: enrichPublicContacts as never,
    });
    const result = await discovery({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverLinkedin).toHaveBeenCalledTimes(1);
    expect(enrichPublicContacts).toHaveBeenCalledTimes(1);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.email).toBe('hello@austindentalstudio.com');
    expect(result.aiAssistance).toBe('disabled');
    expect(result.publicCoverage?.providersChecked).toBe(3);
    expect(result.warnings[0]?.message).toContain('does not use paid databases');
    expect(result.coverage.find((entry) => entry.providerId === 'apollo-audit')?.status).toBe(
      'not_configured',
    );
    expect(result.coverage.find((entry) => entry.providerId === 'rocketreach-audit')?.message).toContain(
      'used or inferred',
    );
  });

  it('merges indexed NotaryCafe phone leads into the same public evidence pipeline', async () => {
    const notaryProfileUrl = 'https://notarycafe.com/Eric.Kaufmann';
    const notaryLead = makeLead({
      id: 'notarycafe-eric-kaufmann',
      name: 'Eric Kaufmann',
      headline: undefined,
      organizationName: 'Colorado Notary & Signing Agent',
      city: 'Austin',
      stateCode: 'TX',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: notaryProfileUrl,
      contactSourceUrl: notaryProfileUrl,
      mobile: '+13034084062',
      contactEvidence: [{
        field: 'phone',
        value: '+13034084062',
        sourceUrl: notaryProfileUrl,
        sourceName: 'NotaryCafe, Indexed Public Search',
        sourceKind: 'public_snippet',
        association: 'business',
      }],
      hasPhone: false,
      verifiedPhone: false,
    });

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      discoverNotaryCafe: vi.fn().mockResolvedValue({
        leads: [notaryLead],
        warnings: [],
        coverage: { queriesAttempted: 1, providersChecked: 1, acceptedCandidates: 1 },
      }) as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'Notary Public', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Eric Kaufmann',
          source: 'NotaryCafe, Indexed Public Search',
          hasPhone: true,
          verifiedPhone: true,
        }),
      ]),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'notarycafe-indexed-search',
        status: 'returned',
        leadCount: 1,
      }),
    );
  });

  it('checks NotaryCafe for unrelated categories without mixing profiles into them', async () => {
    const discoverNotaryCafe = vi.fn().mockResolvedValue({
      leads: [],
      warnings: [],
      coverage: { queriesAttempted: 2, providersChecked: 2, acceptedCandidates: 0 },
    });

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      discoverNotaryCafe: discoverNotaryCafe as never,
    })({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverNotaryCafe).toHaveBeenCalledTimes(1);
    expect(result.leads).toEqual([]);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'notarycafe-indexed-search',
        leadCount: 0,
        status: 'returned',
        message: expect.stringContaining('0 matched /'),
      }),
    );
  });

  it.each([
    'HVAC contractor',
    'Dental Clinics',
    'Immigration Attorneys',
    'Notary Public',
    'Mobile Notary Signing Agent',
  ])('connects the indexed NotaryCafe check for the "%s" search heading', async (companyType) => {
    const discoverNotaryCafe = vi.fn().mockResolvedValue({
      leads: [],
      warnings: [],
      coverage: { queriesAttempted: 2, providersChecked: 2, acceptedCandidates: 0 },
    });

    const discovery = createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      discoverNotaryCafe: discoverNotaryCafe as never,
    });

    const result = await discovery({
      request: { companyType, city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverNotaryCafe).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ companyType }),
        location,
      }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'notarycafe-indexed-search',
        status: 'returned',
      }),
    );
  });

  it.each([
    'HVAC contractor',
    'Dental Clinics',
    'Immigration Attorneys',
    'Roofing Contractors',
    'Plumbers',
    'Mobile Notary Signing Agent',
  ])('merges public directory coverage for every AI heading: "%s"', async (companyType) => {
    const directoryPhone = '+1 512 555 0197';
    const discoverPublicDirectories = vi.fn().mockResolvedValue({
      leads: [makeLead({
        id: `yelp-${companyType}`,
        source: 'Yelp',
        city: 'Austin',
        listingUrl: `https://www.yelp.com/biz/${encodeURIComponent(companyType)}`,
        contactSourceUrl: `https://www.yelp.com/biz/${encodeURIComponent(companyType)}`,
        mobile: directoryPhone,
        hasPhone: true,
        verifiedPhone: true,
        contactEvidence: [{
          field: 'phone',
          value: directoryPhone,
          sourceUrl: `https://www.yelp.com/biz/${encodeURIComponent(companyType)}`,
          sourceName: 'Yelp, Public Directory',
          sourceKind: 'business_listing',
          association: 'business',
        }],
      })],
      warnings: [],
      coverage: [
        {
          providerId: 'yelp-public-directory',
          providerName: 'Yelp, Public Directory',
          status: 'returned' as const,
          leadCount: 1,
          message: 'Directory test result',
        },
        {
          providerId: 'yellow-pages-public-directory',
          providerName: 'Yellow Pages, Public Directory',
          status: 'returned' as const,
          leadCount: 0,
          message: 'Directory test result',
        },
      ],
    });

    const discovery = createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({ leads: [], warnings: [], blocked: false }) as never,
      discoverPublicDirectories: discoverPublicDirectories as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    });

    const result = await discovery({
      request: { companyType, city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverPublicDirectories).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ companyType }),
        location,
      }),
    );
    expect(result.leads).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'Yelp', id: `yelp-${companyType}` }),
    ]));
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'yelp-public-directory',
        status: 'returned',
        leadCount: 1,
      }),
    );
  });

  it('prioritizes NotaryCafe, pure LinkedIn, generic public evidence, then fusion', async () => {
    const notaryCafe = makeLead({
      id: 'notarycafe-priority',
      name: 'NotaryCafe Priority',
      category: 'Notary Public',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: 'https://notarycafe.com/NotaryCafe.Priority',
      contactSourceUrl: 'https://notarycafe.com/NotaryCafe.Priority',
      website: '',
      mobile: '+1 512 555 0101',
      hasPhone: true,
      verifiedPhone: true,
      confidence: 55,
      sourceScore: 55,
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0101',
        sourceUrl: 'https://notarycafe.com/NotaryCafe.Priority',
        sourceName: 'NotaryCafe, Indexed Public Search',
        sourceKind: 'public_snippet',
        association: 'business',
      }],
    });
    const linkedIn = makeLead({
      id: 'linkedin-priority',
      name: 'LinkedIn Priority',
      category: 'Notary Public',
      source: 'LinkedIn, Public Profile',
      listingUrl: 'https://linkedin.com/in/linkedin-priority',
      mobile: '+1 512 555 0102',
      hasPhone: true,
      verifiedPhone: true,
      confidence: 75,
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0102',
        sourceUrl: 'https://linkedin.com/in/linkedin-priority',
        sourceName: 'LinkedIn, Public Profile',
        sourceKind: 'public_snippet',
        association: 'person',
      }],
    });
    const fused = makeLead({
      id: 'gmb-linkedin-priority',
      name: 'GMB LinkedIn Priority',
      category: 'Notary Public',
      source: 'LinkedIn, Public Profile, Google Places',
      listingUrl: 'https://linkedin.com/in/gmb-linkedin-priority',
      contactSourceUrl: 'https://www.google.com/maps/place/gmb-linkedin-priority',
      mobile: '+1 512 555 0103',
      hasPhone: true,
      verifiedPhone: true,
      confidence: 95,
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0103',
        sourceUrl: 'https://www.google.com/maps/place/gmb-linkedin-priority',
        sourceName: 'Google Places',
        sourceKind: 'business_listing',
        association: 'business',
      }],
    });
    const generic = makeLead({
      id: 'generic-priority',
      name: 'Generic Public Priority',
      category: 'Notary Public',
      organizationName: 'Generic Public Priority',
      headline: undefined,
      source: 'OpenStreetMap, Public Business Listing',
      listingUrl: 'https://www.openstreetmap.org/node/generic-priority',
      contactSourceUrl: 'https://www.openstreetmap.org/node/generic-priority',
      website: 'https://generic-public-priority.example',
      mobile: '+1 512 555 0104',
      hasPhone: true,
      verifiedPhone: true,
      confidence: 65,
      sourceScore: 65,
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0104',
        sourceUrl: 'https://www.openstreetmap.org/node/generic-priority',
        sourceName: 'OpenStreetMap, Public Business Listing',
        sourceKind: 'business_listing',
        association: 'business',
      }],
    });

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [linkedIn, fused],
        warnings: [],
        blocked: false,
      }) as never,
      discoverNotaryCafe: vi.fn().mockResolvedValue({
        leads: [notaryCafe],
        warnings: [],
        coverage: { queriesAttempted: 1, providersChecked: 1, acceptedCandidates: 1 },
      }) as never,
      discoverPublicListings: vi.fn().mockResolvedValue([generic]) as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'Notary Public', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads.slice(0, 4).map((lead) => lead.id)).toEqual([
      'notarycafe-priority',
      'linkedin-priority',
      'generic-priority',
      'gmb-linkedin-priority',
    ]);
    expect(result.coverage.find((entry) => entry.providerId === 'linkedin-public-google-business-fusion')).toMatchObject({
      status: 'returned',
      leadCount: 0,
      outcome: 'empty',
    });
  });

  it('location-checks every provider before a result enters the fusion pool', async () => {
    const outOfAreaListing = makeLead({
      id: 'houston-listing',
      city: 'Houston',
      stateCode: 'TX',
      address: 'Houston, TX',
      listingUrl: 'https://www.google.com/maps/place/houston-listing',
      mobile: '+1 713 555 0101',
      hasPhone: true,
      verifiedPhone: true,
      contactEvidence: [{
        field: 'phone',
        value: '+1 713 555 0101',
        sourceUrl: 'https://www.google.com/maps/place/houston-listing',
        sourceName: 'Google Business',
        sourceKind: 'business_listing',
        association: 'business',
      }],
    });

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({ leads: [], warnings: [], blocked: false }) as never,
      discoverPublicListings: vi.fn().mockResolvedValue([outOfAreaListing]) as never,
    })({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        providerId: 'location-acceptance',
        message: expect.stringContaining('out-of-area'),
      }),
    );
  });

  it('keeps public results when website enrichment is unavailable', async () => {
    const publicLead = makeLead();
    const discovery = createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [publicLead],
        warnings: [],
        blocked: false,
      }) as never,
      enrichPublicContacts: vi.fn().mockRejectedValue(new Error('public site timeout')) as never,
    });

    const result = await discovery({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.listingUrl).toBe(publicLead.listingUrl);
    expect(result.coverage.find((entry) => entry.providerId === 'public-website-enrichment')).toMatchObject({
      status: 'partial',
      outcome: 'timed_out',
    });
    expect(result.warnings.some((warning) => warning.message.includes('public site timeout'))).toBe(
      true,
    );
  });

  it('folds deterministic hints into one grounded Gemini pass and keeps public providers as the lead source', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = 'true';

    const discoverLinkedin = vi.fn().mockResolvedValue({
      leads: [],
      warnings: [],
      blocked: false,
      coverage: {
        queriesAttempted: 12,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 0,
        queryFamilies: ['role-led'],
        queryFamilyCounts: { 'role-led': 12 },
      },
    });
    const expandQuery = vi.fn().mockResolvedValue('HVAC service business owner Austin');

    const result = await createAiLeadDiscovery({
      discoverLinkedin: discoverLinkedin as never,
      expandQuery: expandQuery as never,
      discoverGemini: vi.fn().mockResolvedValue({
        candidates: [],
        groundingSources: [],
        leads: [],
      }) as never,
    })({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
      deadlineMs: Date.now() + 20_000,
    });

    expect(expandQuery).not.toHaveBeenCalled();
    expect(discoverLinkedin).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHints: expect.arrayContaining(['hvac contractor owner Austin, TX']),
      }),
    );
    expect(result.aiAssistance).toBe('enabled');
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-query-assistance')).toMatchObject({
      status: 'returned',
      leadCount: 0,
    });
  });

  it('runs exactly one deterministic public LinkedIn pass with category and role lenses', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = 'true';
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'false';

    const discoverLinkedin = vi.fn().mockImplementation(async ({ queryHints }: { queryHints: string[] }) => {
      return {
        leads: [makeLead({
          id: 'deterministic-linkedin-lead',
          mobile: '+1 512 555 0188',
          hasPhone: true,
          verifiedPhone: true,
        })],
        warnings: [],
        blocked: false,
      };
    });
    const expandQuery = vi.fn();

    const result = await createAiLeadDiscovery({
      discoverLinkedin: discoverLinkedin as never,
      expandQuery: expandQuery as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
      deadlineMs: Date.now() + 20_000,
    });

    expect(discoverLinkedin).toHaveBeenCalledTimes(1);
    expect(discoverLinkedin).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHints: expect.arrayContaining(['hvac contractor owner Austin, TX']),
      }),
    );
    expect(expandQuery).not.toHaveBeenCalled();
    expect(result.leads).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deterministic-linkedin-lead', mobile: '+1 512 555 0188' }),
    ]));
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'linkedin-public-search',
        observedCount: 1,
        acceptedCount: 0,
        leadCount: 0,
        message: expect.stringContaining('Deterministic public LinkedIn discovery'),
      }),
    );
  });

  it('does not invent a Gemini quota state for removed query-planning work', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = 'true';
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'false';

    const discoverLinkedin = vi.fn().mockResolvedValue({
      leads: [],
      warnings: [],
      blocked: false,
      coverage: {
        queriesAttempted: 8,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 0,
        queryFamilies: ['role-led'],
        queryFamilyCounts: { 'role-led': 8 },
      },
    });
    const expandQuery = vi.fn().mockRejectedValue(new Error('Request failed with status code 429'));

    const result = await createAiLeadDiscovery({
      discoverLinkedin: discoverLinkedin as never,
      expandQuery: expandQuery as never,
    })({
      request: {
        companyType: 'HVAC contractor',
        city: 'Austin, TX',
        count: 50,
        researchBrief: 'owner-led service businesses',
      },
      location,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.aiAssistance).toBe('disabled');
    expect(discoverLinkedin).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHints: expect.arrayContaining(['owner-led service businesses']),
      }),
    );
    expect(expandQuery).not.toHaveBeenCalled();
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-query-assistance')).toMatchObject({
      status: 'returned',
      outcome: 'returned',
    });
  });

  it('reports grounded Gemini rate limits even when query planning itself succeeded', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = 'true';
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'true';

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({ leads: [], warnings: [], blocked: false }) as never,
      expandQuery: vi.fn().mockResolvedValue([]) as never,
      discoverGemini: vi.fn().mockRejectedValue(new Error('Request failed with status code 429')) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.aiAssistance).toBe('rate_limited');
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-public-discovery')).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('free-tier quota'),
    });
  });

  it('does not add unverified profiles when public search is blocked', async () => {
    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: true,
      }) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toEqual([]);
    expect(result.warnings.some((warning) => /unverified|fabricated/i.test(warning.message))).toBe(
      true,
    );
    expect(result.coverage.find((entry) => entry.providerId === 'linkedin-public-search')).toMatchObject({
      status: 'partial',
      outcome: 'blocked',
    });
  });

  it('retains every Gemini research candidate while keeping contact validation separate', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    delete process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
    delete process.env.GEMINI_LEAD_DISCOVERY_ENABLED;

    const candidate: ResearchCandidate = {
      id: 'gemini-research-1',
      name: 'Avery Smith',
      organizationName: 'Austin Dental Studio',
      originalRole: 'Owner',
      reportedPhone: '+1 512 555 0100',
      reportedEmail: 'avery@austindental.example',
      sourceUrls: ['https://austindental.example/about'],
      evidence: 'Public owner reference.',
      grounded: true,
      status: 'needs_phone_validation',
      discoveredAt: '2026-09-08T00:00:00.000Z',
    };
    const discoverGemini = vi.fn().mockResolvedValue({
      candidates: [candidate],
      groundingSources: [],
      leads: [makeLead({
        id: 'gemini-lead-1',
        name: 'Avery Smith',
        organizationName: 'Austin Dental Studio',
        mobile: '',
        hasPhone: false,
      })],
    });

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      expandQuery: vi.fn().mockResolvedValue([]) as never,
      discoverGemini: discoverGemini as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverGemini).toHaveBeenCalledOnce();
    expect(result.researchCandidates).toEqual([candidate]);
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-public-discovery')).toMatchObject({
      status: 'returned',
      leadCount: 0,
      observedCount: 1,
      reviewCount: 1,
    });
    expect(result.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'gemini-public-discovery',
        reason: 'missing_source_evidence',
        reportedPhone: '+1 512 555 0100',
        sourceUrls: ['https://austindental.example/about'],
      }),
    ]));
    expect(result.leads[0]?.mobile).toBe('');
    expect(result.leads[0]?.hasPhone).toBe(false);
  });

  it('keeps public LinkedIn profiles without a validated business phone in the unified review queue', async () => {
    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [makeLead({
          id: 'linkedin-review-only',
          mobile: '',
          hasPhone: false,
          verifiedPhone: false,
        })],
        warnings: [],
        blocked: false,
      }) as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'linkedin-public-search',
        reason: 'missing_public_phone',
        relatedLeadIds: ['linkedin-review-only'],
      }),
    ]));
    expect(result.coverage.find((entry) => entry.providerId === 'linkedin-public-search')).toMatchObject({
      reviewCount: 1,
    });
  });

  it('passes Google Business listing companies to Gemini for public detail enrichment', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'true';

    const gmbLead = makeLead({
      id: 'google-business-dental',
      name: 'Austin Dental Studio',
      headline: undefined,
      source: 'Google Places',
      listingUrl: 'https://www.google.com/maps/search/?api=1&query=Austin%20Dental%20Studio',
      mobile: '+1 512 555 0198',
      hasPhone: true,
      verifiedPhone: true,
    });
    const candidate: ResearchCandidate = {
      id: 'gemini-gmb-research-1',
      name: 'Avery Smith',
      organizationName: 'Austin Dental Studio',
      originalRole: 'Owner',
      reportedPhone: '+1 512 555 0198',
      reportedEmail: 'avery@austindental.example',
      sourceUrls: [gmbLead.listingUrl ?? ''],
      evidence: 'Public pages identify Avery Smith as the owner of Austin Dental Studio.',
      grounded: true,
      status: 'needs_phone_validation',
      discoveredAt: '2026-09-08T00:00:00.000Z',
    };
    const discoverGemini = vi.fn().mockImplementation(
      async (_request: unknown, _locationLabel: string, listingSeeds: Lead[] = []) => ({
        candidates: listingSeeds.length ? [candidate] : [],
        groundingSources: [],
        leads: listingSeeds.length
          ? [
              makeLead({
                id: 'gemini-gmb-owner',
                name: 'Avery Smith',
                headline: 'Owner at Austin Dental Studio',
                mobile: '',
                hasPhone: false,
                verifiedPhone: false,
              }),
            ]
          : [],
      }),
    );

    const discoverGmbListings = vi.fn().mockResolvedValue([gmbLead]);
    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      discoverGmbListings: discoverGmbListings as never,
      expandQuery: vi.fn().mockResolvedValue([]) as never,
      discoverGemini: discoverGemini as never,
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: leads.length,
      })) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverGemini).toHaveBeenCalledTimes(1);
    expect(discoverGemini.mock.calls[0]?.[2]).toEqual([gmbLead]);
    expect(discoverGmbListings.mock.calls[0]?.[0]?.request).toMatchObject({
      companyType: 'Dentist',
      city: 'Austin, TX',
      sourceMode: 'gmb',
      phoneRequired: true,
    });
    expect(result.researchCandidates).toEqual([candidate]);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'google-places-ai',
        status: 'returned',
        leadCount: 1,
      }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'gemini-listing-enrichment',
        status: 'returned',
        leadCount: 0,
        observedCount: 1,
        reviewCount: 1,
      }),
    );
    expect(result.leads.some((lead) => lead.mobile === gmbLead.mobile)).toBe(true);
  });
});
