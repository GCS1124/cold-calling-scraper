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

  it('does not mix NotaryCafe profiles into unrelated categories', async () => {
    const discoverNotaryCafe = vi.fn();

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

    expect(discoverNotaryCafe).not.toHaveBeenCalled();
    expect(result.leads).toEqual([]);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'notarycafe-indexed-search',
        leadCount: 0,
        message: expect.stringContaining('skipped'),
      }),
    );
  });

  it('prioritizes NotaryCafe evidence before LinkedIn and GMB plus LinkedIn fusion', async () => {
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
      enrichPublicContacts: vi.fn().mockImplementation(async ({ leads }: { leads: Lead[] }) => ({
        leads,
        warnings: [],
        enrichedCount: 0,
      })) as never,
    })({
      request: { companyType: 'Notary Public', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads.slice(0, 3).map((lead) => lead.id)).toEqual([
      'notarycafe-priority',
      'linkedin-priority',
      'gmb-linkedin-priority',
    ]);
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
    expect(result.coverage.find((entry) => entry.providerId === 'public-website-enrichment')?.status).toBe(
      'failed',
    );
    expect(result.warnings.some((warning) => warning.message.includes('public site timeout'))).toBe(
      true,
    );
  });

  it('uses Gemini only as explicit query assistance and keeps public providers as the lead source', async () => {
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

    expect(expandQuery).toHaveBeenCalledWith(
      'HVAC contractor in Austin, TX',
      expect.objectContaining({ companyType: 'HVAC contractor' }),
    );
    expect(discoverLinkedin).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHints: ['HVAC service business owner Austin'],
      }),
    );
    expect(result.aiAssistance).toBe('enabled');
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-query-assistance')).toMatchObject({
      status: 'returned',
      leadCount: 0,
    });
  });

  it('runs the deterministic LinkedIn baseline before Gemini and uses one bounded assisted fallback', async () => {
    process.env.GEMINI_API_KEY = 'user-supplied-test-key';
    process.env.GEMINI_QUERY_ASSISTANCE_ENABLED = 'true';
    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'false';

    let baselineStarted = false;
    const discoverLinkedin = vi.fn().mockImplementation(async ({ queryHints }: { queryHints: string[] }) => {
      if (!queryHints.length) {
        baselineStarted = true;
        return { leads: [], warnings: [], blocked: false };
      }

      return {
        leads: [makeLead({
          id: 'assisted-linkedin-lead',
          mobile: '+1 512 555 0188',
          hasPhone: true,
          verifiedPhone: true,
        })],
        warnings: [],
        blocked: false,
      };
    });
    const expandQuery = vi.fn().mockImplementation(async () => {
      expect(baselineStarted).toBe(true);
      return 'HVAC service business owner Austin';
    });

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

    expect(discoverLinkedin).toHaveBeenCalledTimes(2);
    expect(discoverLinkedin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ queryHints: [] }),
    );
    expect(discoverLinkedin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        queryHints: ['HVAC service business owner Austin'],
        request: expect.objectContaining({ researchDepth: 'quick' }),
      }),
    );
    expect(result.leads).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assisted-linkedin-lead', mobile: '+1 512 555 0188' }),
    ]));
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        providerId: 'linkedin-public-search',
        leadCount: 1,
        message: expect.stringContaining('bounded Gemini-assisted'),
      }),
    );
  });

  it('labels Gemini quota pressure without interrupting deterministic public expansion', async () => {
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
    const expandQuery = vi.fn().mockRejectedValue(
      new Error('Request failed with status code 429'),
    );

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

    expect(result.aiAssistance).toBe('rate_limited');
    expect(discoverLinkedin).toHaveBeenCalledWith(
      expect.objectContaining({
        queryHints: ['owner-led service businesses'],
      }),
    );
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-query-assistance')).toMatchObject({
      status: 'partial',
      message: expect.stringContaining('free-tier quota'),
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'gemini-query-assistance',
          message: expect.stringContaining('deterministic public expansion continued'),
        }),
      ]),
    );
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
    expect(result.coverage.find((entry) => entry.providerId === 'linkedin-public-search')?.status).toBe(
      'failed',
    );
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
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverGemini).toHaveBeenCalledOnce();
    expect(result.researchCandidates).toEqual([candidate]);
    expect(result.coverage.find((entry) => entry.providerId === 'gemini-public-discovery')).toMatchObject({
      status: 'returned',
      leadCount: 1,
    });
    expect(result.leads[0]?.mobile).toBe('');
    expect(result.leads[0]?.hasPhone).toBe(false);
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

    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: false,
      }) as never,
      discoverGmbListings: vi.fn().mockResolvedValue([gmbLead]) as never,
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
        leadCount: 1,
      }),
    );
    expect(result.leads.some((lead) => lead.mobile === gmbLead.mobile)).toBe(true);
  });
});
